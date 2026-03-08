/**
 * Financial Transaction Manager - Node.js Backend
 *
 * Main application entry point.
 * Mirrors: apps/backend/main.py (Python/FastAPI backend)
 */

import express from 'express';
import cors from 'cors';
import { getSettings } from './config/config.js';
import { logger } from './config/logger.js';
import { checkConnection, closePool } from './database/connection.js';

// Import route modules
import transactionsRouter from './routes/transactions.js';
import categoriesRouter from './routes/categories.js';
import recipientsRouter from './routes/recipients.js';
import plannedTransactionsRouter from './routes/plannedTransactions.js';
import infoRouter from './routes/info.js';
import adminRouter from './routes/admin.js';
import importRouter from './routes/importRoutes.js';
import investmentsRouter from './routes/investments.js';
import { rateLimiter, adminRateLimiter, importRateLimiter } from './middleware/rateLimiter.js';

const settings = getSettings();
const app = express();

// ==================== Middleware ====================

// CORS
app.use(cors({
  origin: settings.api.corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
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

// Request logging (development only)
if (settings.isDevelopment()) {
  app.use((req, res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
  });
}

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

app.get('/', (req, res) => {
  res.json({
    message: 'Financial Transaction Manager API (Node.js)',
    version: settings.api.version,
    docs: '/api/',
  });
});

// ==================== Route Registration ====================

// Global rate limiter
app.use(rateLimiter({ windowMs: 60_000, maxRequests: 200, keyPrefix: 'global' }));

app.use('/api/transactions', transactionsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/recipients', recipientsRouter);
app.use('/api/planned-transactions', plannedTransactionsRouter);
app.use('/api/info', infoRouter);
app.use('/api/admin', adminRateLimiter, adminRouter);
app.use('/api/import', importRateLimiter, importRouter);

logger.info('All route modules registered successfully');

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

async function start() {
  // Verify database connection
  const isConnected = await checkConnection();
  if (isConnected) {
    logger.info('Database connection verified successfully');
  } else {
    logger.error('Failed to connect to database. Check DATABASE_URL configuration.');
    logger.info(`DATABASE_URL: ${settings.database.url.replace(/:[^:@]+@/, ':***@')}`);
  }

  app.listen(PORT, HOST, () => {
    logger.info(`Financial Transaction Manager API (Node.js) started`, {
      host: HOST,
      port: PORT,
      environment: settings.server.environment,
      version: settings.api.version,
    });
    logger.info(`API documentation: http://${HOST}:${PORT}/api/`);
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  await closePool();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  await closePool();
  process.exit(0);
});

start().catch((err) => {
  logger.error('Failed to start application', { error: err.message });
  process.exit(1);
});
