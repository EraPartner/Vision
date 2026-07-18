/**
 * Financial Transaction Manager - Node.js Backend
 *
 * Main application entry point.
 */

import express from 'express';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import { createGzip } from 'node:zlib';
import { dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { getSettings } from './config/config.js';
import { logger } from './config/logger.js';
import { checkConnection, closePool, getPoolStats, query } from './database/connection.js';
import { runMigrations } from './database/migrate.js';
import {
  createMaterializedViews,
  ensureMaterializedViewIndexes,
} from './services/materializedViewService.js';
import { createErrorHandler, NotFoundError } from './middleware/errorHandler.js';
import { createAdminAuthMiddleware, isLoopbackHost } from './middleware/adminAuth.js';
import { createCsrfGuard } from './middleware/csrfGuard.js';
import { closeBrowser as closePuppeteerBrowser } from './services/reports/puppeteerRenderer.js';
import { wrapResponse } from './middleware/envelope.js';
import { requestId } from './middleware/requestId.js';
import { requestMetrics } from './middleware/requestMetrics.js';
import { cancelPendingAggregationRefresh } from './services/aggregationRefresh.js';
import { runWarmupTasks } from './startup/warmup.js';

const adminAuthMiddleware = createAdminAuthMiddleware(() => settings.admin.authToken);
// Blocks cross-site state-changing requests (browser CSRF), which the loopback
// binding alone cannot stop. Mounted across the whole data plane below; the
// alias documents intent at the (now redundant) admin mount point.
const csrfGuard = createCsrfGuard(() => settings.api.corsOrigins);
const adminCsrfGuard = csrfGuard;

// Import route modules
import transactionsRouter from './routes/transactions.js';
import categoriesRouter from './routes/categories.js';
import recipientsRouter from './routes/recipients.js';
import plannedTransactionsRouter from './routes/plannedTransactions.js';
import infoRouter from './routes/info.js';
import aggregationsRouter from './routes/aggregations.js';
import adminRouter from './routes/admin.js';
import importRouter from './routes/importRoutes.js';
import portfolioImportRouter from './routes/portfolioImportRoutes.js';
import investmentsRouter from './routes/investments.js';
import recipientBankAccountsRouter from './routes/recipientBankAccounts.js';
import settingsRouter from './routes/settings.js';
import marketLookupRouter from './routes/marketLookup.js';
import researchRouter from './routes/research.js';
import watchlistRouter from './routes/watchlist.js';
import splitsRouter from './routes/splits.js';
import savedChartsRouter from './routes/savedCharts.js';
import aiRouter from './routes/ai.js';
import attachmentsRouter from './routes/attachments.js';
import reportsRouter from './routes/reports.js';
import tagsRouter from './routes/tags.js';
import accountsRouter from './routes/accounts.js';
import crossWorkspaceRouter from './routes/crossWorkspace.js';
import {
  rateLimiter,
  globalRateLimiter,
  adminRateLimiter,
  importRateLimiter,
  attachmentRateLimiter,
  spaRateLimiter,
  reportRateLimiter,
  marketRateLimiter,
  investmentRateLimiter,
  aggregationRateLimiter,
} from './middleware/rateLimiter.js';
import { buildRouteManifest, mountRouter } from './services/routeManifest.js';

const settings = getSettings();
const app = express();

// ==================== Middleware ====================

// Request ID — must run first so every other middleware and logger sees `req.id`.
app.use(requestId);

// Request metrics — rolling in-memory window for /api/admin/metrics/requests.
app.use(requestMetrics);

// CORS
const CORS_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const CORS_ALLOWED_HEADERS = 'Content-Type,Authorization,X-Request-Id';
const CORS_EXPOSED_HEADERS = 'X-Request-Id';

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = settings.api.corsOrigins;
  const isWildcard = allowed === '*';
  // Never combine wildcard origin with credentials (browsers reject; CodeQL flags
  // it as an injection vector). Reflect only origins on an explicit allowlist.
  const originAllowed = Array.isArray(allowed)
    ? allowed.includes(origin)
    : !isWildcard && allowed === origin;

  if (originAllowed && origin) {
    // Vary: Origin tells shared caches not to serve this response to other origins.
    res.setHeader('Vary', 'Origin');
    // codeql[js/cors-misconfiguration]: origin is validated against the settings allowlist above; wildcard is never combined with credentials.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS);
  } else if (isWildcard && settings.security.devBypass) {
    // Dev convenience only: wildcard origin without credentials. Gated on the
    // explicit VISION_DEV opt-in so an unset env never reflects a wildcard.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSED_HEADERS);
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Max-Age', '600');
    res.writeHead(204).end();
    return;
  }

  next();
});

// JSON body parser with size limit
app.use(express.json({ limit: '1mb' }));

// Security headers (production-ready)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0'); // Deprecated; rely on CSP instead
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  if (settings.isProduction()) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  next();
});

// Response compression (gzip via node:zlib)
const COMPRESSIBLE_RE = /json|text|javascript|xml|svg|x-www-form-urlencoded/;
const NO_COMPRESS_BELOW = 1024;

app.use((req, res, next) => {
  const acceptEncoding = req.headers['accept-encoding'] ?? '';
  if (!acceptEncoding.includes('gzip')) return next();

  const _write = res.write.bind(res);
  const _end = res.end.bind(res);
  let gz = null;
  let setupDone = false;

  const setup = () => {
    if (setupDone) return;
    setupDone = true;
    if (res.headersSent) return;
    const contentType = String(res.getHeader('Content-Type') ?? '');
    const contentLength = parseInt(String(res.getHeader('Content-Length') ?? '0'), 10);
    // Never gzip SSE: the gzip transform buffers input until a block fills,
    // which would batch tokens and break per-event delivery.
    if (contentType.includes('text/event-stream')) return;
    if (String(res.getHeader('X-Accel-Buffering') ?? '').toLowerCase() === 'no') return;
    if (!COMPRESSIBLE_RE.test(contentType)) return;
    if (contentLength > 0 && contentLength < NO_COMPRESS_BELOW) return;
    gz = createGzip();
    res.removeHeader('Content-Length');
    res.setHeader('Content-Encoding', 'gzip');
    // The representation now varies by Accept-Encoding — a shared cache/proxy
    // must not serve this gzipped body to an identical-URL request that didn't
    // send Accept-Encoding: gzip. Merge, don't clobber, any existing Vary.
    const existingVary = String(res.getHeader('Vary') ?? '');
    if (!/\bAccept-Encoding\b/i.test(existingVary)) {
      res.setHeader('Vary', existingVary ? `${existingVary}, Accept-Encoding` : 'Accept-Encoding');
    }

    // Downstream backpressure: pause gz when raw socket buffer is full,
    // resume on socket drain. Without this the gzip transform spins until
    // its own buffer fills and then the response stalls.
    gz.on('data', (chunk) => {
      if (_write(chunk) === false) {
        gz.pause();
        res.once('drain', () => gz.resume());
      }
    });
    gz.on('end', () => _end());
    // Upstream backpressure: when gz drains, surface the drain on res so
    // pipe sources (e.g. fs.createReadStream from express.static) resume.
    gz.on('drain', () => res.emit('drain'));
    gz.on('error', (err) => res.destroy(err));
  };

  res.write = (chunk, encoding, cb) => {
    setup();
    if (gz) return gz.write(chunk, encoding, cb);
    return _write(chunk, encoding, cb);
  };

  res.end = (chunk, encoding, cb) => {
    setup();
    if (gz) {
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = undefined;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        encoding = undefined;
      }
      if (chunk != null && chunk !== '') gz.write(chunk, encoding);
      gz.end();
      if (typeof cb === 'function') gz.once('end', cb);
      return res;
    }
    return _end(chunk, encoding, cb);
  };

  next();
});

// Request logging
app.use((req, res, next) => {
  logger.debug(`[REQ] ${req.method} ${req.originalUrl}`, { requestId: req.id });
  next();
});

// Unified response envelope — attaches res.ok(data, meta?) before routers run.
app.use(wrapResponse);

// ==================== Health Check ====================

// Tri-state warmup tracking: each task is 'pending' until it settles, then
// 'ready' (success) or 'failed' (best-effort task errored). runWarmupTasks
// mutates these. The wire format below keeps a backward-compatible boolean
// `caches` map (the Electron shell gates first navigation on
// `caches.materializedViews === true`) and adds `warmup` (tri-state) + `degraded`.
const WARMUP_KEYS = ['exchangeRates', 'inflation', 'portfolioSnapshots', 'infoCaches', 'materializedViews'];
const warmupStatus = Object.fromEntries(WARMUP_KEYS.map((k) => [k, 'pending']));

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'financial-transaction-manager-node',
    version: settings.api.version,
    timestamp: new Date().toISOString(),
  });
});

// /health/* sits outside /api, so the global rate limiter doesn't apply — and
// the detailed probe costs a DB round-trip. Cache the probe result briefly so
// a hammering client (or an exposed port) can't turn health checks into a DB
// DoS; 1s staleness is irrelevant for a liveness signal.
const DB_PROBE_TTL_MS = 1000;
let dbProbeCache = { value: false, expiresAt: 0 };
async function checkConnectionCached() {
  const now = Date.now();
  if (now < dbProbeCache.expiresAt) return dbProbeCache.value;
  const value = await checkConnection();
  dbProbeCache = { value, expiresAt: now + DB_PROBE_TTL_MS };
  return value;
}

app.get('/health/detailed', async (req, res) => {
  const states = Object.values(warmupStatus);
  const warming = states.includes('pending');
  const degraded = states.includes('failed');

  // Real liveness probe — a SELECT 1 round-trip catches a wedged pool that a
  // process-level "I'm listening" check would miss. checkConnection never throws.
  const dbConnected = await checkConnectionCached();

  res.json({
    status: warming ? 'warming' : 'ready', // unchanged contract: 'ready' once warmup settles (pass or fail)
    degraded, // a best-effort warmup task failed; app is serving but missing some warm data
    service: 'financial-transaction-manager-node',
    version: settings.api.version,
    timestamp: new Date().toISOString(),
    database: { connected: dbConnected, pool: getPoolStats() },
    warmup: { ...warmupStatus }, // tri-state: pending | ready | failed
    // Backward-compatible boolean map (true once a task settles, pass or fail) —
    // consumed by the Electron readiness gate. Prefer `warmup` for new code.
    caches: Object.fromEntries(WARMUP_KEYS.map((k) => [k, warmupStatus[k] !== 'pending'])),
  });
});

// ==================== API Root ====================

app.get('/api/', (req, res) => {
  res.json({
    version: settings.api.version,
    title: settings.api.title,
    description: settings.api.description,
    runtime: 'Node.js/Express',
    links: [],
  });
});

// ==================== Route Registration ====================

// Baseline rate limiting across the whole data plane. Mounted before every
// router so previously-unthrottled routes (/api/transactions, /api/settings, …)
// get a DoS backstop; stricter per-route limiters below stack on top.
app.use('/api', globalRateLimiter);

// CSRF backstop across the whole data plane. Previously only /api/admin was
// guarded, leaving state-changing data-plane routes (/api/import/csv,
// /api/portfolio/import, /api/attachments, …) forgeable via a cross-site
// multipart POST (a CORS-simple request that fires without preflight). The
// guard is stateless (Sec-Fetch-Site/Origin based) so same-origin SPA and
// Electron-main requests pass unchanged.
app.use('/api', csrfGuard);

mountRouter(app, '/api/transactions', transactionsRouter);
mountRouter(app, '/api/categories', categoriesRouter);
mountRouter(app, '/api/recipients', recipientsRouter);
mountRouter(app, '/api/recipients', recipientBankAccountsRouter);
mountRouter(app, '/api/planned-transactions', plannedTransactionsRouter);
mountRouter(app, '/api/info', infoRouter);
mountRouter(app, '/api/aggregations', aggregationRateLimiter, aggregationsRouter);
mountRouter(app, '/api/admin', adminRateLimiter, adminCsrfGuard, adminAuthMiddleware, adminRouter);
mountRouter(app, '/api/import', importRateLimiter, importRouter);
mountRouter(app, '/api/portfolio/import', importRateLimiter, portfolioImportRouter);
mountRouter(app, '/api/investments', investmentRateLimiter, investmentsRouter);
mountRouter(app, '/api/settings', settingsRouter);
mountRouter(app, '/api/market', marketRateLimiter, marketLookupRouter);
mountRouter(app, '/api/research', marketRateLimiter, researchRouter);
mountRouter(app, '/api/watchlist', watchlistRouter);
mountRouter(app, '/api/splits', splitsRouter);
mountRouter(app, '/api/saved-charts', savedChartsRouter);
mountRouter(app, '/api/attachments', attachmentRateLimiter, attachmentsRouter);
mountRouter(app, '/api/reports', reportRateLimiter, reportsRouter);
mountRouter(app, '/api/tags', tagsRouter);
mountRouter(app, '/api/accounts', accountsRouter);
mountRouter(app, '/api/cross-workspace', crossWorkspaceRouter);

// AI chat: dedicated per-minute limit on /chat (Ollama calls are expensive);
// other /api/ai/* endpoints fall back to the global limiter.
if (settings.aiChat?.enabled) {
  const aiChatLimiter = rateLimiter({
    windowMs: 60_000,
    maxRequests: settings.aiChat.rateLimit,
    keyPrefix: 'ai-chat',
  });
  app.use('/api/ai/chat', aiChatLimiter);
  mountRouter(app, '/api/ai', aiRouter);
  logger.debug(`AI chat routes enabled (/api/ai), chat rate limit: ${settings.aiChat.rateLimit}/min`);
} else {
  logger.info('AI chat routes disabled (settings.aiChat.enabled = false)');
}


// Build route manifest after all routes are registered so /api/admin/endpoints
// reflects the full router stack.
buildRouteManifest(app);

// ==================== Static Frontend (Production) ====================
// Serve the built React app when running in production (Docker/standalone)
// Must be registered AFTER API routes but BEFORE the 404 handler.
if (settings.isProduction()) {
  const distPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');
  // Only Vite's content-hashed bundles live under dist/assets/ — those are
  // safe to cache for a year. Everything else in dist/ has a stable name
  // (index.html, favicon.ico, robots.txt, …) and must revalidate, or an
  // explicit GET for it is pinned for a year and never sees an app update
  // (stale shells then 404 on their old hashed chunk URLs after an upgrade).
  // `index: false` only disables directory-index resolution, it does not
  // exempt those files from the long-lived cache header.
  const hashedAssetsPrefix = resolve(distPath, 'assets') + sep;
  app.use(express.static(distPath, {
    index: false,
    maxAge: '1y',
    immutable: true,
    setHeaders: (res, filePath) => {
      if (!filePath.startsWith(hashedAssetsPrefix)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  // Preload the SPA shell once at startup; the fallback route then serves it
  // from memory with no per-request file I/O.
  const indexHtml = fs.readFileSync(resolve(distPath, 'index.html'), 'utf-8');
  app.get(/^(?!\/api)/, spaRateLimiter, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(indexHtml);
  });
}

// ==================== Error Handling ====================

// 404 handler — funnel through the error handler so the envelope stays uniform.
app.use((req, res, next) => {
  next(new NotFoundError(`Not Found: ${req.method} ${req.path}`));
});

// Global error handler — typed errors (AppError, ValidationError, NotFoundError, …)
// map to their declared status; untyped errors fall through to 500.
app.use(createErrorHandler(() => settings.isProduction()));

// ==================== Server Startup ====================

const PORT = settings.server.port;
const HOST = settings.server.host;

// Background interval handles — captured here so graceful shutdown can clear them.
let exchangeRateRefreshInterval = null;
let quotesRefreshInterval = null;
let cashflowForecastRefreshInterval = null;
let holdingGapBackfillInterval = null;

// HTTP server handle — module-scoped so shutdown() can drain in-flight requests.
let httpServer = null;
// Guards shutdown() against a second SIGINT/SIGTERM re-entering mid-drain.
let isShuttingDown = false;

// ── Boot instrumentation ───────────────────────────────────────────────────
const BOOT_TRACE_ENABLED = process.env.VISION_BOOT_TRACE !== '0';
const _bootT0 = Date.now();
const _bootMarks = [];
function bootMark(phase) {
  const t0 = Date.now();
  return () => {
    const ms = Date.now() - t0;
    _bootMarks.push({ phase, ms });
    if (BOOT_TRACE_ENABLED) {
      process.stderr.write(`[startup] ${JSON.stringify({ phase, ms })}\n`);
    }
    return ms;
  };
}
function bootSummary(extraPhase = 'backend_total') {
  const total = Date.now() - _bootT0;
  if (BOOT_TRACE_ENABLED) {
    process.stderr.write(`[startup] ${JSON.stringify({ phase: extraPhase, ms: total, marks: _bootMarks })}\n`);
  }
}

async function start() {
  if (!settings.admin.authToken) {
    // A non-loopback bind with no token means /api/admin/* (including
    // destructive routes) is reachable by anyone who can reach the port, with
    // no per-request check. Refuse to start rather than rely on a log line —
    // unless the operator explicitly acknowledges an outer restriction
    // (ADMIN_ALLOW_TOKENLESS_NONLOOPBACK, set by the documented compose flow
    // where the container binds 0.0.0.0 but the port is published on host
    // loopback only).
    if (!isLoopbackHost(HOST) && !settings.admin.allowTokenlessNonLoopback) {
      logger.error(
        `Refusing to start: bind address '${HOST}' is not loopback and ADMIN_AUTH_TOKEN is not set. ` +
        'Set ADMIN_AUTH_TOKEN to protect /api/admin/*, bind to 127.0.0.1/localhost, or — only if an ' +
        'outer layer already restricts access (e.g. Docker publishing the port on host loopback) — ' +
        'set ADMIN_ALLOW_TOKENLESS_NONLOOPBACK=true.'
      );
      process.exit(1);
    }
    logger.warn(
      'ADMIN_AUTH_TOKEN is not set — admin endpoints have no per-request token check. ' +
      'This is safe only because the port is published on 127.0.0.1 (loopback). The CSRF ' +
      'guard blocks cross-site *state-changing* requests, but NOT cross-site GET reads ' +
      '(safe methods are exempt), so it is not by itself an authorization boundary. If you ' +
      'publish the port on 0.0.0.0 or behind a proxy, SET ADMIN_AUTH_TOKEN to enforce token-based auth.'
    );
  }

  try {
    // Wait for PostgreSQL to be fully ready.
    // With depends_on removed from docker-compose, both containers start in
    // parallel. On a cold first-ever start postgres can take up to ~30s to
    // initialise its data directory, so we give it 40 attempts with exponential
    // backoff (max 1s). On warm starts postgres is up in <100ms.
    let dbReady = false;
    let attemptCount = 0;
    const maxAttempts = 40;
    const baseDelay = 50; // Start with 50ms
    const maxDelay = 1000;

    const endDbPoll = bootMark('db_poll');
    while (!dbReady && attemptCount < maxAttempts) {
      const isConnected = await checkConnection();
      if (isConnected) {
        dbReady = true;
        endDbPoll();
        logger.info('Database connection verified successfully');
        // Run alembic migrations (fail-fast on non-zero exit).
        // Alembic is the single source of schema DDL (ADR-027).
        const endMig = bootMark('run_migrations');
        await runMigrations();
        endMig();
        // Materialized views are runtime artifacts, not schema — create/index/refresh
        // after the underlying tables exist.
        const endCreateMv = bootMark('create_mat_views');
        await createMaterializedViews();
        endCreateMv();
        const endIdxMv = bootMark('ensure_mv_indexes');
        await ensureMaterializedViewIndexes();
        endIdxMv();
        // One database-wide ANALYZE at boot so small, rarely-mutated tables
        // (which no migration or trigger ever ANALYZEs) still hand the planner
        // fresh statistics. Fire-and-forget: ANALYZE only refreshes planner
        // stats (idempotent, non-destructive), so it must never delay `listen`
        // or block boot — hence not awaited, errors swallowed. This is complementary
        // to, not in conflict with, the post-migration targeted ANALYZE in
        // migrate.js: that one guarantees the two big, migration-rewritten tables
        // are fresh immediately after an upgrade; this one covers every remaining
        // table on every boot. On a boot that just migrated, the two big tables
        // are simply re-sampled here — harmless (ANALYZE is idempotent), and the
        // whole-DB sample is cheap on this dataset.
        query('ANALYZE').catch((err) =>
          logger.warn({ err: err.message }, 'boot-time ANALYZE failed; non-fatal'),
        );
        // refreshMaterializedViews moved to post-listen warmup so /health
        // goes green sooner. Stale MV data is acceptable for the first few
        // seconds of warm boot.
      } else {
        attemptCount++;
        // Exponential backoff: 50ms, 100ms, 200ms... capped at 1000ms
        const delay = Math.min(baseDelay * Math.pow(2, attemptCount - 1), maxDelay);
        logger.debug(`Waiting for database to be ready (attempt ${attemptCount}/${maxAttempts}, next retry in ${delay}ms)`);
        await sleep(delay);
      }
    }

    if (!dbReady) {
      logger.error('Database connection failed after multiple attempts');
      logger.info(`DATABASE_URL: ${settings.database.url.replace(/:[^:@]+@/, ':***@')}`);
      throw new Error('Failed to connect to database');
    }

    // Start Express server immediately after DB is ready
    const endListen = bootMark('app_listen');
    const server = app.listen(PORT, HOST, async () => {
      endListen();
      bootSummary('backend_total');
      logger.info(`Financial Transaction Manager API (Node.js) started`, {
        host: HOST,
        port: PORT,
        environment: settings.server.environment,
        version: settings.api.version,
      });

      try {
        const intervals = await runWarmupTasks({ warmupStatus });
        exchangeRateRefreshInterval = intervals.exchangeRateRefreshInterval;
        quotesRefreshInterval = intervals.quotesRefreshInterval;
        cashflowForecastRefreshInterval = intervals.cashflowForecastRefreshInterval;
        holdingGapBackfillInterval = intervals.holdingGapBackfillInterval;
      } catch (err) {
        logger.error('Warmup tasks failed', { error: err.message });
      }
    });

    httpServer = server;

    server.on('error', (err) => {
      logger.error('HTTP server error', { error: err.message });
      process.exit(1);
    });
  } catch (err) {
    logger.error('Failed to start application', { error: err.message });
    process.exit(1);
  }
}

// Graceful shutdown
const SHUTDOWN_FORCE_EXIT_MS = 10_000;

async function shutdown(signal) {
  // A second SIGINT/SIGTERM while a drain is already in progress should not
  // restart the sequence — just note it and let the first run finish.
  if (isShuttingDown) {
    logger.warn(`Received ${signal || 'signal'} during shutdown — already draining`);
    return;
  }
  isShuttingDown = true;
  logger.info('Shutting down...', { signal });

  // Hard backstop: if draining hangs (a stuck request, a pool that won't
  // close), force-exit rather than wedging the process forever.
  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_FORCE_EXIT_MS);
  forceExit.unref();

  if (exchangeRateRefreshInterval) clearInterval(exchangeRateRefreshInterval);
  if (quotesRefreshInterval) clearInterval(quotesRefreshInterval);
  if (cashflowForecastRefreshInterval) clearInterval(cashflowForecastRefreshInterval);
  if (holdingGapBackfillInterval) clearInterval(holdingGapBackfillInterval);
  cancelPendingAggregationRefresh();

  // Stop accepting new connections and let in-flight requests finish before
  // tearing down the pool — closePool() mid-request would error live handlers.
  if (httpServer) {
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
      // close() alone leaves idle keep-alive sockets (browser tabs, the
      // Electron health watchdog's keepAlive agent) holding the server open
      // until the 10s force-exit. Drop them explicitly; in-flight requests
      // are untouched. Optional-chained: not every runtime implements it.
      httpServer.closeIdleConnections?.();
    });
  }

  await Promise.allSettled([closePool(), closePuppeteerBrowser()]);
  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Last-resort handlers. Node terminates the process on an unhandled rejection
// or uncaught exception anyway — but with no structured log line, so under a
// supervisor (Docker `restart: unless-stopped`, Electron) the only visible
// symptom is a container that silently bounced. Log with stack + requestId
// (when the error carries one) so the crash leaves a trace, then exit non-zero
// to hand control back to the supervisor for a clean restart. Many of the
// fire-and-forget chains here (warmup, deferred refresh, SSE) are exactly where
// a stray rejection would otherwise escape unseen.
function logFatal(kind, err) {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error(`${kind} — exiting`, {
    error: error.message,
    stack: error.stack,
    requestId: /** @type {any} */ (error).requestId,
  });
}

process.on('unhandledRejection', (reason) => {
  logFatal('Unhandled promise rejection', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logFatal('Uncaught exception', err);
  process.exit(1);
});

start().catch((err) => {
  logger.error('Failed to start application', { error: err.message });
  process.exit(1);
});

