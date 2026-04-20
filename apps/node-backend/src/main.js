/**
 * Financial Transaction Manager - Node.js Backend
 *
 * Main application entry point.
 * Mirrors: apps/backend/main.py (Python/FastAPI backend)
 */

import express from 'express';
import cors from 'cors';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getSettings } from './config/config.js';
import { logger } from './config/logger.js';
import { checkConnection, closePool } from './database/connection.js';
import { initializeSchema } from './database/schemaInit.js';
import {
  warmCache as warmExchangeRateCache,
  clearMemoryCache as clearExchangeRateCache,
  backfillPortfolioHistoricalRates,
} from './services/currencyConversionService.js';
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
import { createErrorHandler } from './middleware/errorHandler.js';

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

function extractAdminBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return undefined;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

function adminAuthMiddleware(req, res, next) {
  const configuredToken = settings.admin.authToken;
  if (!configuredToken) {
    return next();
  }

  const providedToken = extractAdminBearerToken(req.headers.authorization);
  if (!providedToken || providedToken !== configuredToken) {
    return res.status(401).json({ detail: 'Unauthorized' });
  }

  return next();
}

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
import { rateLimiter, adminRateLimiter, importRateLimiter } from './middleware/rateLimiter.js';

const settings = getSettings();
const app = express();

// ==================== Middleware ====================

// CORS
app.use(cors({
  origin: settings.api.corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

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

// Response compression (gzip)
import('compression').then(({ default: compression }) => {
  app.use(compression());
}).catch(() => {
  logger.warn('compression package not installed, responses will not be compressed');
});

// Request logging
app.use((req, res, next) => {
  logger.debug(`[REQ] ${req.method} ${req.originalUrl}`);
  next();
});

// ==================== Health Check ====================

const warmupStatus = {
  exchangeRates: false,
  inflation: false,
  portfolioSnapshots: false,
  infoCaches: false,
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

// Global rate limiter
const globalLimiter = rateLimiter({ windowMs: 60_000, maxRequests: 200, keyPrefix: 'global' });
app.use(globalLimiter);

app.use('/api/transactions', transactionsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/recipients', recipientsRouter);
app.use('/api/recipients', recipientBankAccountsRouter);
app.use('/api/planned-transactions', plannedTransactionsRouter);
app.use('/api/info', infoRouter);
if (settings.features?.aggregationsV2Enabled) {
  app.use('/api/aggregations', aggregationsRouter);
  logger.info('Aggregations V2 routes enabled (/api/aggregations)');
}
app.use('/api/admin', adminRateLimiter, adminAuthMiddleware, adminRouter);
app.use('/api/import', importRateLimiter, importRouter);
app.use('/api/investments', investmentsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/market', marketLookupRouter);
app.use('/api/watchlist', watchlistRouter);
app.use('/api/splits', splitsRouter);
app.use('/api/saved-charts', savedChartsRouter);

// AI chat: dedicated per-minute limit on /chat (Ollama calls are expensive);
// other /api/ai/* endpoints fall back to the global limiter.
if (settings.aiChat?.enabled) {
  const aiChatLimiter = rateLimiter({
    windowMs: 60_000,
    maxRequests: settings.aiChat.rateLimit,
    keyPrefix: 'ai-chat',
  });
  app.use('/api/ai/chat', aiChatLimiter);
  app.use('/api/ai', aiRouter);
  logger.info(`AI chat routes enabled (/api/ai), chat rate limit: ${settings.aiChat.rateLimit}/min`);
} else {
  logger.info('AI chat routes disabled (settings.aiChat.enabled = false)');
}

logger.info('All route modules registered successfully');

// ==================== Static Frontend (Production) ====================
// Serve the built React app when running in production (Docker/standalone)
// Must be registered AFTER API routes but BEFORE the 404 handler.
if (settings.isProduction()) {
  const distPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist');
  // Hashed assets (JS/CSS) — long-lived cache
  app.use(express.static(distPath, { index: false, maxAge: '1y', immutable: true }));
  // SPA fallback: serve index.html (no-cache) for all non-API paths
  app.get(/^(?!\/api)/, globalLimiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(resolve(distPath, 'index.html'));
  });
}

// ==================== Error Handling ====================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    detail: `Not Found: ${req.method} ${req.path}`,
  });
});

// Global error handler — typed errors (AppError, ValidationError, NotFoundError, …)
// map to their declared status; untyped errors fall through to 500.
app.use(createErrorHandler(() => settings.isProduction()));

// ==================== Server Startup ====================

const PORT = settings.server.port;
const HOST = settings.server.host;

// Exchange rate refresh interval handle
let exchangeRateRefreshInterval = null;

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

    while (!dbReady && attemptCount < maxAttempts) {
      const isConnected = await checkConnection();
      if (isConnected) {
        dbReady = true;
        logger.info('Database connection verified successfully');
        // Ensure all tables exist (idempotent)
        await initializeSchema();
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
    app.listen(PORT, HOST, () => {
      logger.info(`Financial Transaction Manager API (Node.js) started`, {
        host: HOST,
        port: PORT,
        environment: settings.server.environment,
        version: settings.api.version,
      });
      logger.info(`API documentation: http://${HOST}:${PORT}/api/`);

      // Warm exchange rate cache AFTER server is accepting connections.
      // This avoids blocking startup while waiting for external API calls.
      warmExchangeRateCache()
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

      backfillPortfolioHistoricalRates().catch((err) => {
        logger.error('Failed to backfill portfolio historical exchange rates on startup', { error: err.message });
      });

      backfillHistoricalAssetQuotes().catch((err) => {
        logger.error('Failed to backfill historical asset quotes on startup', { error: err.message });
      });

      sanitizePersistedKinesisHistory().catch((err) => {
        logger.error('Failed to sanitize persisted Kinesis history on startup', { error: err.message });
      });

      computeAndStoreSnapshots()
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
    });
  } catch (err) {
    logger.error('Failed to start application', { error: err.message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  if (exchangeRateRefreshInterval) clearInterval(exchangeRateRefreshInterval);
  await closePool();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  if (exchangeRateRefreshInterval) clearInterval(exchangeRateRefreshInterval);
  await closePool();
  process.exit(0);
});

start().catch((err) => {
  logger.error('Failed to start application', { error: err.message });
  process.exit(1);
});
