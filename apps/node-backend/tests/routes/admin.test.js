/**
 * Admin route tests.
 * Mirrors: apps/backend/tests/test_admin.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { checkConnection, getTableCount } from '../../src/database/connection.js';
import { getSettings } from '../../src/config/config.js';
import adminRoutes from '../../src/routes/admin.js';

describe('Admin Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return admin status when connected', async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(5);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(adminRoutes, 'get', '/')(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.is_initialised).toBe(true);
      expect(result.table_count).toBe(5);
      expect(result.timestamp).toBeDefined();
    });

    it('should report uninitialised when no tables', async () => {
      checkConnection.mockResolvedValue(true);
      getTableCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(adminRoutes, 'get', '/')(req, res);

      expect(res.json.mock.calls[0][0].is_initialised).toBe(false);
    });

    it('should report uninitialised when disconnected', async () => {
      checkConnection.mockResolvedValue(false);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(adminRoutes, 'get', '/')(req, res);

      expect(res.json.mock.calls[0][0].is_initialised).toBe(false);
      expect(res.json.mock.calls[0][0].table_count).toBe(0);
    });

    it('should handle errors with 500', async () => {
      checkConnection.mockRejectedValue(new Error('Connection failed'));

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(adminRoutes, 'get', '/')(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /database/init', () => {
    it('should verify connection successfully', async () => {
      checkConnection.mockResolvedValue(true);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(adminRoutes, 'post', '/database/init')(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 500 when cannot connect', async () => {
      checkConnection.mockResolvedValue(false);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(adminRoutes, 'post', '/database/init')(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /database/reset', () => {
    it('should return 404 when reset is disabled', async () => {
      getSettings.mockReturnValue({ admin: { enableResetDb: false } });

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(adminRoutes, 'post', '/database/reset')(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should require force parameter', async () => {
      getSettings.mockReturnValue({ admin: { enableResetDb: true } });

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(adminRoutes, 'post', '/database/reset')(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should accept force=true', async () => {
      getSettings.mockReturnValue({ admin: { enableResetDb: true } });

      const req = { query: { force: 'true' } };
      const res = mockResponse();
      await getRouteHandler(adminRoutes, 'post', '/database/reset')(req, res);

      expect(res.json).toHaveBeenCalled();
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function getRouteHandler(router, method, path) {
  const layer = router.stack.find(
    l => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No handler for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}
