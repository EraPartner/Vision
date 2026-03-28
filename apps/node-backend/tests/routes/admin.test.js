/**
 * Admin route tests.
 * Mirrors: apps/backend/tests/test_admin.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, handler) => { routeHandlers[`get:${path}`] = handler; }),
  post: vi.fn((path, handler) => { routeHandlers[`post:${path}`] = handler; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/database/connection.js', () => ({
  checkConnection: vi.fn(),
  getTableCount: vi.fn(),
  query: vi.fn(),
}));

vi.mock('../../src/config/config.js', () => ({
  getSettings: vi.fn(() => ({
    admin: { enableResetDb: false },
  })),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/services/priceProviderService.js', () => ({
  sanitizePersistedKinesisHistory: vi.fn(),
}));

import { checkConnection, getTableCount } from '../../src/database/connection.js';
import { getSettings } from '../../src/config/config.js';
import { sanitizePersistedKinesisHistory } from '../../src/services/priceProviderService.js';
await import('../../src/routes/admin.js');

describe('Admin Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return status when connected', async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(5);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.is_initialised).toBe(true);
      expect(result.table_count).toBe(5);
      expect(result.timestamp).toBeDefined();
    });

    it('should report uninitialised with no tables', async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].is_initialised).toBe(false);
    });

    it('should report uninitialised when disconnected', async () => {
      checkConnection.mockResolvedValue(false);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].is_initialised).toBe(false);
      expect(res.json.mock.calls[0][0].table_count).toBe(0);
    });

    it('should handle errors with 500', async () => {
      checkConnection.mockRejectedValue(new Error('Connection failed'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /database/init', () => {
    it('should verify connection successfully', async () => {
      checkConnection.mockResolvedValue(true);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/database/init'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 500 when cannot connect', async () => {
      checkConnection.mockResolvedValue(false);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/database/init'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /database/reset', () => {
    it('should return 404 when reset disabled', async () => {
      getSettings.mockReturnValue({ admin: { enableResetDb: false } });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/database/reset'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should require force parameter', async () => {
      getSettings.mockReturnValue({ admin: { enableResetDb: true } });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/database/reset'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should accept force=true', async () => {
      getSettings.mockReturnValue({ admin: { enableResetDb: true } });

      const req = { query: { force: 'true' } };
      const res = mockResponse();
      await routeHandlers['post:/database/reset'](req, res);

      expect(res.json).toHaveBeenCalled();
    });
  });

  describe('POST /investments/kinesis/sanitize-history', () => {
    it('should sanitize persisted kinesis history and return summary', async () => {
      sanitizePersistedKinesisHistory.mockResolvedValue({
        processed: 3,
        updated: 2,
        correctedPoints: 4,
        failed: 0,
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/investments/kinesis/sanitize-history'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        message: 'Kinesis historical spikes sanitization completed',
        processed: 3,
        updated: 2,
        correctedPoints: 4,
        failed: 0,
      });
    });

    it('should return 500 when sanitization fails', async () => {
      sanitizePersistedKinesisHistory.mockRejectedValue(new Error('boom'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/investments/kinesis/sanitize-history'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
