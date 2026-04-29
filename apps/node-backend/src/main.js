/**
 * Financial Transaction Manager - Node.js Backend
 *
 * Main application entry point.
 * Mirrors: apps/backend/main.py (Python/FastAPI backend)
 */

import express from 'express';
import fs from 'node:fs';
import { createGzip } from 'node:zlib';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getSettings } from './config/config.js';
import { logger } from './config/logger.js';
import { checkConnection, closePool } from './database/connection.js';
import { runMigrations } from './database/migrate.js';
import {
  createMaterializedViews,
  ensureMaterializedViewIndexes,
  refreshMaterializedViews,
} from './services/materializedViewService.js';
import {
  warmCache as warmExchangeRateCache,
  clearMemoryCache as clearExchangeRateCache,
  backfillPortfolioHistoricalRates,
} from './services/currency/currencyConversionService.js';
import {
  warmInflationCache,
  clearInflationMemoryCache,
} from './services/belgianInflationService.js';
import investmentRepository from './repositories/investmentRepository.js';
import {
  fetchLivePricesDetailed,
  sanitizePersistedKinesisHistory,
} from './services/priceProviderService.js';
import { getKinesisAssetConfig } from './config/kinesisConfig.js';
import { computeAndStoreSnapshots } from './services/portfolioPerformanceSnapshotService.js';
import {
  backfillHistoricalAssetQuotes,
  refreshActiveHoldingQuotes,
} from './services/quoteBackfillService.js';
import { warmInfoCaches } from './routes/info.js';
import { createErrorHandler, NotFoundError } from './middleware/errorHandler.js';
import { createAdminAuthMiddleware } from './middleware/adminAuth.js';
import { closeBrowser as closePuppeteerBrowser } from './services/reports/puppeteerRenderer.js';
import { wrapResponse } from './middleware/envelope.js';
import { requestId } from './middleware/requestId.js';
import { requestMetrics } from './middleware/requestMetrics.js';
import { refreshCashflowForecastMc } from './jobs/refreshCashflowForecastMc.js';

function hasLivePriceRefreshConfig(investment) {
  const provider = investment?.price_provider;
  if (!provider || provider === 'manual') return false;

  if (provider === 'custom') {
    return Boolean(
      investment?.price_provider_latest_url
      || investment?.price_provider_url
      || investment?.price_provider_history_url
    );
  }

  if (provider === 'yahoo') {
    return Boolean(investment?.price_provider_id || investment?.symbol);
  }

  if (provider === 'kinesis') {
    if (investment?.price_provider_id) return true;
    const assetName = (investment?.name || investment?.symbol || '').toLowerCase().trim();
    return Boolean(assetName && getKinesisAssetConfig(assetName));
  }

  return Boolean(investment?.price_provider_id);
}

function isValidStoredPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

const adminAuthMiddleware = createAdminAuthMiddleware(() => settings.admin.authToken);

async function persistRefreshedPrices(prices) {
  const updateResults = await Promise.all(
    Object.entries(prices).map(async ([investmentId, priceData]) => {
      const { price, source } = priceData || {};
      if (price == null || Number.isNaN(price) || source === 'cached') return 0;

      await investmentRepository.updatePrice(parseInt(investmentId, 10), {
        current_price: price,
        price_updated_at: new Date().toISOString(),
      });
      return 1;
    })
  );

  // eslint-disable-next-line vision-local-money/no-raw-money-arithmetic
  return updateResults.reduce((sum, count) => sum + count, 0);
}

async function refreshInvestmentPricesOnStartup() {
  const allInvestments = await investmentRepository.getAll({ limit: 1000, active: true });
  const toRefresh = allInvestments.filter(hasLivePriceRefreshConfig);

  if (toRefresh.length === 0) {
    logger.info('No startup investment price refresh needed');
    return;
  }

  const cachedPricesByInvestmentId = Object.fromEntries(
    toRefresh.map(i => [i.id, Number(i.current_price)])
  );

  const deferredKinesisRefresh = [];
  const immediateRefresh = [];

  for (const investment of toRefresh) {
    if (investment.price_provider === 'kinesis' && isValidStoredPrice(cachedPricesByInvestmentId[investment.id])) {
      deferredKinesisRefresh.push(investment);
      continue;
    }
    immediateRefresh.push(investment);
  }

  if (immediateRefresh.length > 0) {
    const prices = await fetchLivePricesDetailed(immediateRefresh, { cachedPricesByInvestmentId });
    const updated = await persistRefreshedPrices(prices);
    logger.info(`Startup immediate investment price refresh completed: ${updated}/${immediateRefresh.length}`);
  } else {
    logger.info('Startup immediate investment price refresh skipped: all configured investments have usable stored prices');
  }

  if (deferredKinesisRefresh.length > 0) {
    logger.info(`Startup deferred Kinesis price refresh scheduled for ${deferredKinesisRefresh.length} investment(s)`);
    setTimeout(() => {
      fetchLivePricesDetailed(deferredKinesisRefresh)
        .then(prices => persistRefreshedPrices(prices))
        .then((updated) => {
          logger.info(`Startup deferred Kinesis price refresh completed: ${updated}/${deferredKinesisRefresh.length}`);
        })
        .catch((err) => {
          logger.error('Startup deferred Kinesis price refresh failed', { error: err.message });
        });
    }, 0);
  }
}

// Import route modules
import transactionsRouter from './routes/transactions.js';
import categoriesRouter from './routes/categories.js';
import recipientsRouter from './routes/recipients.js';
import plannedTransactionsRouter from './routes/plannedTransactions.js';
import infoRouter from './routes/info.js';
import aggregationsRouter from './routes/aggregations.js';
import adminRouter from './routes/admin.js';
import importRouter from './routes/importRoutes.js';
import investmentsRouter from './routes/investments.js';
import recipientBankAccountsRouter from './routes/recipientBankAccounts.js';
import settingsRouter from './routes/settings.js';
import marketLookupRouter from './routes/marketLookup.js';
import watchlistRouter from './routes/watchlist.js';
import splitsRouter from './routes/splits.js';
import savedChartsRouter from './routes/savedCharts.js';
import aiRouter from './routes/ai.js';
import attachmentsRouter from './routes/attachments.js';
import reportsRouter from './routes/reports.js';
import {
  rateLimiter,
  adminRateLimiter,
  importRateLimiter,
  attachmentRateLimiter,
  spaRateLimiter,
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
  } else if (isWildcard && settings.isDevelopment()) {
    // Dev convenience only: wildcard origin without credentials.
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
    if (!COMPRESSIBLE_RE.test(contentType)) return;
    if (contentLength > 0 && contentLength < NO_COMPRESS_BELOW) return;
    gz = createGzip();
    res.removeHeader('Content-Length');
    res.setHeader('Content-Encoding', 'gzip');
    gz.on('data', (chunk) => _write(chunk));
    gz.on('end', () => _end());
  };

  res.write = (chunk, encoding, cb) => {
    setup();
    if (gz) return gz.write(chunk, encoding, cb);
    return _write(chunk, encoding, cb);
  };

  res.end = (chunk, encoding, cb) => {
    setup();
    if (gz) {
      if (chunk != null && chunk !== '') gz.write(chunk, encoding);
      gz.end();
      if (typeof cb === 'function') gz.once('finish', cb);
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

const warmupStatus = {
  exchangeRates: false,
  inflation: false,
  portfolioSnapshots: false,
  infoCaches: false,
  materializedViews: false,
};

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'financial-transaction-manager-node',
    version: settings.api.version,
    timestamp: new Date().toISOString(),
  });
});

app.get('/health/detailed', (req, res) => {
  const ready = Object.values(warmupStatus).every(Boolean);
  res.json({
    status: ready ? 'ready' : 'warming',
    service: 'financial-transaction-manager-node',
    version: settings.api.version,
    timestamp: new Date().toISOString(),
    caches: { ...warmupStatus },
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


mountRouter(app, '/api/transactions', transactionsRouter);
mountRouter(app, '/api/categories', categoriesRouter);
mountRouter(app, '/api/recipients', recipientsRouter);
mountRouter(app, '/api/recipients', recipientBankAccountsRouter);
mountRouter(app, '/api/planned-transactions', plannedTransactionsRouter);
mountRouter(app, '/api/info', infoRouter);
mountRouter(app, '/api/aggregations', aggregationsRouter);
mountRouter(app, '/api/admin', adminRateLimiter, adminAuthMiddleware, adminRouter);
mountRouter(app, '/api/import', importRateLimiter, importRouter);
mountRouter(app, '/api/investments', investmentsRouter);
mountRouter(app, '/api/settings', settingsRouter);
mountRouter(app, '/api/market', marketLookupRouter);
mountRouter(app, '/api/watchlist', watchlistRouter);
mountRouter(app, '/api/splits', splitsRouter);
mountRouter(app, '/api/saved-charts', savedChartsRouter);
mountRouter(app, '/api/attachments', attachmentRateLimiter, attachmentsRouter);
mountRouter(app, '/api/reports', reportsRouter);

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
  // Hashed assets (JS/CSS) — long-lived cache
  app.use(express.static(distPath, { index: false, maxAge: '1y', immutable: true }));
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

// Exchange rate refresh interval handle
let exchangeRateRefreshInterval = null;

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
        // refreshMaterializedViews moved to post-listen warmup so /health
        // goes green sooner. Stale MV data is acceptable for the first few
        // seconds of warm boot.
      } else {
        attemptCount++;
        // Exponential backoff: 50ms, 100ms, 200ms... capped at 1000ms
        const delay = Math.min(baseDelay * Math.pow(2, attemptCount - 1), maxDelay);
        logger.debug(`Waiting for database to be ready (attempt ${attemptCount}/${maxAttempts}, next retry in ${delay}ms)`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (!dbReady) {
      logger.error('Database connection failed after multiple attempts');
      logger.info(`DATABASE_URL: ${settings.database.url.replace(/:[^:@]+@/, ':***@')}`);
      throw new Error('Failed to connect to database');
    }

    // Start Express server immediately after DB is ready
    const endListen = bootMark('app_listen');
    app.listen(PORT, HOST, () => {
      endListen();
      bootSummary('backend_total');
      logger.info(`Financial Transaction Manager API (Node.js) started`, {
        host: HOST,
        port: PORT,
        environment: settings.server.environment,
        version: settings.api.version,
      });
      // Refresh materialized views off the boot critical path. Stale data
      // is acceptable for the first few seconds; /health/detailed reflects
      // readiness via warmupStatus.materializedViews.
      refreshMaterializedViews()
        .then(() => { warmupStatus.materializedViews = true; })
        .catch((err) => {
          warmupStatus.materializedViews = true;
          logger.error('Failed to refresh materialized views on startup', { error: err.message });
        });

      // Warm exchange rate cache AFTER server is accepting connections.
      // This avoids blocking startup while waiting for external API calls.
      // Captured as a promise so dependent tasks (info caches) can wait for it.
      const exchangeRateWarmPromise = warmExchangeRateCache()
        .then(() => { warmupStatus.exchangeRates = true; })
        .catch((err) => {
          warmupStatus.exchangeRates = true;
          logger.error('Failed to warm exchange rate cache on startup', { error: err.message });
        });

      warmInflationCache()
        .then(() => { warmupStatus.inflation = true; })
        .catch((err) => {
          warmupStatus.inflation = true;
          logger.error('Failed to warm Belgian inflation cache on startup', { error: err.message });
        });

      // Run backfill concurrently but capture promise so snapshots can wait.
      const fxBackfillPromise = backfillPortfolioHistoricalRates().catch((err) => {
        logger.error('Failed to backfill portfolio historical exchange rates on startup', { error: err.message });
      });

      backfillHistoricalAssetQuotes().catch((err) => {
        logger.error('Failed to backfill historical asset quotes on startup', { error: err.message });
      });

      sanitizePersistedKinesisHistory().catch((err) => {
        logger.error('Failed to sanitize persisted Kinesis history on startup', { error: err.message });
      });

      // Wait for exchange rates and FX backfill before computing snapshots/info
      // caches — both depend on exchange_rates rows being present in the DB.
      Promise.all([exchangeRateWarmPromise, fxBackfillPromise])
        .then(() => computeAndStoreSnapshots())
        .then(() => {
          warmupStatus.portfolioSnapshots = true;
          return warmInfoCaches()
            .then(() => { warmupStatus.infoCaches = true; })
            .catch((err) => {
              warmupStatus.infoCaches = true;
              logger.error('Failed to warm info caches on startup', { error: err.message });
            });
        })
        .catch((err) => {
          warmupStatus.portfolioSnapshots = true;
          warmupStatus.infoCaches = true;
          logger.error('Failed to compute portfolio performance snapshots on startup', { error: err.message });
        });

      refreshInvestmentPricesOnStartup().catch((err) => {
        logger.error('Failed to refresh investment prices on startup', { error: err.message });
      });

      // Schedule automatic exchange rate refresh every 12 hours so rates stay
      // current even when no currency conversions are triggered by user activity
      exchangeRateRefreshInterval = setInterval(async () => {
        logger.info('Running scheduled exchange rate refresh...');
        clearExchangeRateCache();
        await warmExchangeRateCache().catch((err) => {
          logger.error('Scheduled exchange rate refresh failed', { error: err.message });
        });

        clearInflationMemoryCache();
        await warmInflationCache().catch((err) => {
          logger.error('Scheduled Belgian inflation refresh failed', { error: err.message });
        });
      }, 12 * 60 * 60 * 1000); // every 12 hours

      // Schedule hourly quote refresh for currently-held investments
      setInterval(() => {
        refreshActiveHoldingQuotes().catch((err) => {
          logger.error('Periodic quote refresh failed', { error: err.message });
        });
      }, 60 * 60 * 1000); // every hour

      // Nightly cashflow forecast MC cache pre-warm (runs 24h after startup,
      // then every 24h so daytime requests hit cache instead of re-running MC).
      setInterval(() => {
        refreshCashflowForecastMc().catch((err) => {
          logger.error('Nightly cashflow forecast MC refresh failed', { error: err.message });
        });
      }, 24 * 60 * 60 * 1000); // every 24 hours
    });
  } catch (err) {
    logger.error('Failed to start application', { error: err.message });
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown() {
  logger.info('Shutting down...');
  if (exchangeRateRefreshInterval) clearInterval(exchangeRateRefreshInterval);
  await Promise.allSettled([closePool(), closePuppeteerBrowser()]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  logger.error('Failed to start application', { error: err.message });
  process.exit(1);
});
