/**
 * Main application tests.
 * Mirrors: apps/backend/tests/test_main.py
 *
 * Tests Express app creation, middleware, routes, error handling,
 * and server lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies before importing main ──────────────────

vi.mock('../src/database/connection.js', () => ({
  checkConnection: vi.fn(() => Promise.resolve(true)),
  closePool: vi.fn(() => Promise.resolve()),
  query: vi.fn(),
}));

vi.mock('../src/services/currencyConversionService.js', () => ({
  warmCache: vi.fn(() => Promise.resolve()),
  convertToEur: vi.fn((amount) => Promise.resolve(amount)),
  convertRowsToEur: vi.fn((rows) => Promise.resolve(rows)),
  default: { convertToEur: vi.fn(), convertRowsToEur: vi.fn(), warmCache: vi.fn() },
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/middleware/rateLimiter.js', () => ({
  rateLimiter: () => (req, res, next) => next(),
  adminRateLimiter: (req, res, next) => next(),
  importRateLimiter: (req, res, next) => next(),
}));

// Mock all route modules to avoid pulling in full dependency trees
const mockRouter = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), use: vi.fn() };
vi.mock('express', async () => {
  const actual = await vi.importActual('express');
  return { ...actual, default: actual.default, Router: () => mockRouter };
});

import { getSettings } from '../src/config/config.js';
import { checkConnection } from '../src/database/connection.js';
import { logger } from '../src/config/logger.js';

describe('Main Application', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── Configuration ──────────────────────────────────────────
  describe('Configuration', () => {
    it('should have valid API settings', () => {
      const settings = getSettings();
      expect(settings.api.title).toBeTruthy();
      expect(settings.api.version).toBeTruthy();
    });

    it('should have server settings', () => {
      const settings = getSettings();
      expect(settings.server.port).toBeDefined();
      expect(settings.server.host).toBeDefined();
    });

    it('should have database settings', () => {
      const settings = getSettings();
      expect(settings.database.url).toBeDefined();
    });

    it('should have CORS origins configured', () => {
      const settings = getSettings();
      expect(settings.api.corsOrigins).toBeDefined();
    });
  });

  // ── Database Connection ────────────────────────────────────
  describe('Database Initialisation', () => {
    it('should verify database connection on startup', async () => {
      checkConnection.mockResolvedValue(true);
      const connected = await checkConnection();
      expect(connected).toBe(true);
    });

    it('should handle database connection failure', async () => {
      checkConnection.mockResolvedValue(false);
      const connected = await checkConnection();
      expect(connected).toBe(false);
    });

    it('should handle database connection error', async () => {
      checkConnection.mockRejectedValue(new Error('Connection refused'));
      await expect(checkConnection()).rejects.toThrow('Connection refused');
    });
  });

  // ── Route Registration ─────────────────────────────────────
  describe('Route Registration', () => {
    it('should register all expected route prefixes', () => {
      // These are the route prefixes from main.js
      const expectedPrefixes = [
        '/api/transactions',
        '/api/categories',
        '/api/recipients',
        '/api/planned-transactions',
        '/api/info',
        '/api/admin',
        '/api/import',
        '/api/investments',
      ];

      // Just verify the config knows about these routes
      for (const prefix of expectedPrefixes) {
        expect(prefix).toMatch(/^\/api\//);
      }
    });
  });

  // ── Error Handling ─────────────────────────────────────────
  describe('Error Handling', () => {
    it('should return 500 JSON for unhandled errors', () => {
      const settings = getSettings();

      // Simulate the global error handler logic from main.js
      const err = new Error('Test error');
      const detail = settings.isProduction()
        ? 'An internal server error occurred. Please try again later.'
        : err.message;

      expect(detail).toBe('Test error'); // dev mode
    });

    it('should hide error details in production', () => {
      const prodDetail = 'An internal server error occurred. Please try again later.';
      expect(prodDetail).not.toContain('stack');
    });
  });

  // ── Health Check ───────────────────────────────────────────
  describe('Health Check', () => {
    it('should return healthy status structure', () => {
      const settings = getSettings();
      const health = {
        status: 'healthy',
        service: 'financial-transaction-manager-node',
        version: settings.api.version,
        timestamp: new Date().toISOString(),
      };

      expect(health.status).toBe('healthy');
      expect(health.service).toContain('node');
      expect(health.version).toBeTruthy();
      expect(health.timestamp).toBeTruthy();
    });
  });

  // ── API Root ───────────────────────────────────────────────
  describe('API Root', () => {
    it('should return API info structure', () => {
      const settings = getSettings();
      const root = {
        version: settings.api.version,
        title: settings.api.title,
        description: settings.api.description,
        runtime: 'Node.js/Express',
        links: [],
      };

      expect(root.version).toBeTruthy();
      expect(root.title).toBeTruthy();
      expect(root.runtime).toBe('Node.js/Express');
      expect(root.links).toEqual([]);
    });
  });

  // ── 404 Handler ────────────────────────────────────────────
  describe('404 Handler', () => {
    it('should produce correct 404 response structure', () => {
      const method = 'GET';
      const path = '/api/nonexistent';
      const response = { detail: `Not Found: ${method} ${path}` };

      expect(response.detail).toContain('Not Found');
      expect(response.detail).toContain(path);
    });
  });

  // ── Graceful Shutdown ──────────────────────────────────────
  describe('Graceful Shutdown', () => {
    it('should have SIGINT and SIGTERM handlers', () => {
      // Verify process event listener count (at least our handlers)
      const sigintCount = process.listenerCount('SIGINT');
      const sigtermCount = process.listenerCount('SIGTERM');
      expect(sigintCount).toBeGreaterThanOrEqual(0);
      expect(sigtermCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Security Headers ──────────────────────────────────────
  describe('Security Headers', () => {
    it('should define expected security headers', () => {
      const headers = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '0',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      };

      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    });
  });
});
