/**
 * Recipient route tests.
 * Mirrors: apps/backend/tests/test_recipients.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/recipientRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    createOrGet: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import recipientRepository from '../../src/repositories/recipientRepository.js';
import recipientRoutes from '../../src/routes/recipients.js';

describe('Recipient Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return empty list', async () => {
      recipientRepository.getAll.mockResolvedValue([]);
      recipientRepository.getCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'get', '/')(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.limit).toBe(50);
    });

    it('should return recipients with data', async () => {
      const recipients = [
        { id: 1, name: 'JOHN DOE', is_active: true },
        { id: 2, name: 'JANE SMITH', is_active: true },
      ];
      recipientRepository.getAll.mockResolvedValue(recipients);
      recipientRepository.getCount.mockResolvedValue(2);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'get', '/')(req, res);

      expect(res.json.mock.calls[0][0].total).toBe(2);
    });
  });

  describe('POST /', () => {
    it('should create recipient with 201', async () => {
      recipientRepository.createOrGet.mockResolvedValue({
        recipient: { id: 1, name: 'JOHN DOE', is_active: true },
        created: true,
      });

      const req = { body: { name: 'John Doe' } };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'post', '/')(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 200 for duplicate', async () => {
      recipientRepository.createOrGet.mockResolvedValue({
        recipient: { id: 1, name: 'JOHN DOE', is_active: true },
        created: false,
      });

      const req = { body: { name: 'John Doe' } };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'post', '/')(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should return 400 for missing name', async () => {
      const req = { body: {} };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'post', '/')(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /:id', () => {
    it('should return recipient by id', async () => {
      recipientRepository.getById.mockResolvedValue({ id: 1, name: 'JOHN DOE' });

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'get', '/:id')(req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      recipientRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'get', '/:id')(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('PATCH /:id', () => {
    it('should update recipient', async () => {
      recipientRepository.update.mockResolvedValue({ id: 1, name: 'UPDATED', notes: 'new' });

      const req = { params: { id: '1' }, body: { notes: 'new' } };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'patch', '/:id')(req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      recipientRepository.update.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { notes: 'x' } };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'patch', '/:id')(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /:id', () => {
    it('should delete recipient', async () => {
      recipientRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'delete', '/:id')(req, res);

      expect(res.json.mock.calls[0][0].message).toContain('deleted permanently');
    });

    it('should return 404 for non-existent', async () => {
      recipientRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await getRouteHandler(recipientRoutes, 'delete', '/:id')(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
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
