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
import { warmCache as warmExchangeRateCache, clearMemoryCache as clearExchangeRateCache } from './services/currencyConversionService.js';
import PostgresManager from './database/postgresManager.js';

// Import route modules
import transactionsRouter from './routes/transactions.js';
import categoriesRouter from './routes/categories.js';
import recipientsRouter from './routes/recipients.js';
import plannedTransactionsRouter from './routes/plannedTransactions.js';
import infoRouter from './routes/info.js';
import adminRouter from './routes/admin.js';
import importRouter from './routes/importRoutes.js';
import investmentsRouter from './routes/investments.js';
import recipientBankAccountsRouter from './routes/recipientBankAccounts.js';
import settingsRouter from './routes/settings.js';
import marketLookupRouter from './routes/marketLookup.js';
import watchlistRouter from './routes/watchlist.js';
import splitsRouter from './routes/splits.js';
import savedChartsRouter from './routes/savedCharts.js';
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
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'");
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

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'financial-transaction-manager-node',
    version: settings.api.version,
    timestamp: new Date().toISOString(),
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
app.use('/api/admin', adminRateLimiter, adminRouter);
app.use('/api/import', importRateLimiter, importRouter);
app.use('/api/investments', investmentsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/market', marketLookupRouter);
app.use('/api/watchlist', watchlistRouter);
app.use('/api/splits', splitsRouter);
  app.use('/api/saved-charts', savedChartsRouter);

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

// Global error handler
app.use((err, req, res, _next) => {
  logger.error('Unhandled exception', {
    error: err.message,
    path: req.path,
    method: req.method,
  });

  // Don't leak error details in production
  const detail = settings.isProduction()
    ? 'An internal server error occurred. Please try again later.'
    : err.message;

  res.status(500).json({
    detail,
    error_code: 'INTERNAL_SERVER_ERROR',
  });
});

// ==================== Server Startup ====================

const PORT = settings.server.port;
const HOST = settings.server.host;
const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = resolve(moduleDir, '..', '..', '..');

// PostgreSQL manager instance
let postgresManager = null;
// Exchange rate refresh interval handle
let exchangeRateRefreshInterval = null;

async function start() {
  try {
    // Initialize PostgreSQL manager with project root
    const projectRoot = process.env.PROJECT_ROOT || defaultProjectRoot;
    postgresManager = new PostgresManager(projectRoot);

    // Start PostgreSQL server (initialize if needed)
    if (process.env.EXTERNAL_DATABASE === 'true') {
      logger.info('EXTERNAL_DATABASE mode: skipping local PostgreSQL management, expecting external DB at DATABASE_URL');
    } else {
      logger.info('PostgreSQL initialization and startup...');
      try {
        await postgresManager.start();
        logger.info('PostgreSQL server is ready');
      } catch (error) {
        logger.error('Failed to start PostgreSQL', {
          error: error.message,
          dataDir: postgresManager.postgresDataDir,
        });
        logger.error('Make sure PostgreSQL is installed: brew install postgresql@15');
        throw error;
      }
    }

    // Wait for PostgreSQL to be fully ready.
    // With depends_on removed from docker-compose, both containers start in
    // parallel. On a cold first-ever start postgres can take up to ~30s to
    // initialise its data directory, so we give it 40 attempts (40 seconds)
    // rather than the previous 20. On warm starts postgres is up in <2s so
    // the extra headroom costs nothing.
    let dbReady = false;
    let attemptCount = 0;
    const maxAttempts = 40;

    while (!dbReady && attemptCount < maxAttempts) {
      const isConnected = await checkConnection();
      if (isConnected) {
        dbReady = true;
        logger.info('Database connection verified successfully');
        // Ensure all tables exist (idempotent)
        await initializeSchema();
        // Pre-warm exchange rate cache (non-blocking) - fetch fresh rates from ECB on startup
        warmExchangeRateCache().catch((err) => {
          logger.error('Failed to warm exchange rate cache on startup', { error: err.message });
        });

        // Schedule automatic exchange rate refresh every 12 hours so rates stay
        // current even when no currency conversions are triggered by user activity
        exchangeRateRefreshInterval = setInterval(async () => {
          logger.info('Running scheduled exchange rate refresh...');
          clearExchangeRateCache();
          await warmExchangeRateCache().catch((err) => {
            logger.error('Scheduled exchange rate refresh failed', { error: err.message });
          });
        }, 12 * 60 * 60 * 1000); // every 12 hours
      } else {
        attemptCount++;
        logger.debug(`Waiting for database to be ready (attempt ${attemptCount}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    if (!dbReady) {
      logger.error('Database connection failed after multiple attempts');
      logger.info(`DATABASE_URL: ${settings.database.url.replace(/:[^:@]+@/, ':***@')}`);
      throw new Error('Failed to connect to database');
    }

    // Start Express server
    app.listen(PORT, HOST, () => {
      logger.info(`Financial Transaction Manager API (Node.js) started`, {
        host: HOST,
        port: PORT,
        environment: settings.server.environment,
        version: settings.api.version,
      });
      logger.info(`API documentation: http://${HOST}:${PORT}/api/`);
    });
  } catch (err) {
    logger.error('Failed to start application', { error: err.message });
    // Stop PostgreSQL if it was started
    if (postgresManager) {
      try {
        await postgresManager.stop();
      } catch (stopError) {
        logger.error('Error stopping PostgreSQL during startup failure', {
          error: stopError.message,
        });
      }
    }
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  if (exchangeRateRefreshInterval) clearInterval(exchangeRateRefreshInterval);
  await closePool();
  if (postgresManager) {
    try {
      await postgresManager.stop();
    } catch (error) {
      logger.warn('Error stopping PostgreSQL during shutdown', {
        error: error.message,
      });
    }
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  if (exchangeRateRefreshInterval) clearInterval(exchangeRateRefreshInterval);
  await closePool();
  if (postgresManager) {
    try {
      await postgresManager.stop();
    } catch (error) {
      logger.warn('Error stopping PostgreSQL during shutdown', {
        error: error.message,
      });
    }
  }
  process.exit(0);
});

start().catch((err) => {
  logger.error('Failed to start application', { error: err.message });
  process.exit(1);
});
