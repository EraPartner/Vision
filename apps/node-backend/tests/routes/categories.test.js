/**
 * Category route tests.
 * Mirrors: apps/backend/tests/test_categories.py
 *
 * Uses mocked repository layer for unit testing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the repository and logger
vi.mock('../../src/repositories/categoryRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    createOrGet: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
    assignToRecipients: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import categoryRepository from '../../src/repositories/categoryRepository.js';
import express from 'express';
import categoryRoutes from '../../src/routes/categories.js';

// We can't use supertest without installing it, so we test route handler logic directly
describe('Category Routes - Handler Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/categories', () => {
    it('should return empty list for empty database', async () => {
      categoryRepository.getAll.mockResolvedValue([]);
      categoryRepository.getCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();

      // Get the handler from the router
      const handler = getRouteHandler(categoryRoutes, 'get', '/');
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      }));
    });

    it('should return categories with data', async () => {
      const categories = [
        { id: 1, general: 'GROCERIES', detail: 'FOOD', description: 'test' },
        { id: 2, general: 'TRANSPORT', detail: 'FUEL', description: null },
      ];
      categoryRepository.getAll.mockResolvedValue(categories);
      categoryRepository.getCount.mockResolvedValue(2);

      const req = { query: {} };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'get', '/');
      await handler(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.total).toBe(2);
      expect(result.items.length).toBe(2);
    });

    it('should respect pagination parameters', async () => {
      categoryRepository.getAll.mockResolvedValue([{ id: 2 }]);
      categoryRepository.getCount.mockResolvedValue(5);

      const req = { query: { limit: '2', offset: '1' } };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'get', '/');
      await handler(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(1);
    });
  });

  describe('POST /api/categories', () => {
    it('should create a new category and return 201', async () => {
      categoryRepository.createOrGet.mockResolvedValue({
        category: { id: 1, general: 'GROCERIES', detail: 'FOOD' },
        created: true,
      });

      const req = { body: { general: 'groceries', detail: 'food' } };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'post', '/');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 200 for duplicate category', async () => {
      categoryRepository.createOrGet.mockResolvedValue({
        category: { id: 1, general: 'GROCERIES', detail: 'FOOD' },
        created: false,
      });

      const req = { body: { general: 'groceries', detail: 'food' } };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'post', '/');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should return 400 for missing fields', async () => {
      const req = { body: { general: 'groceries' } };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'post', '/');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /api/categories/:id', () => {
    it('should return category by id', async () => {
      categoryRepository.getById.mockResolvedValue({ id: 1, general: 'GROCERIES', detail: 'FOOD' });

      const req = { params: { id: '1' } };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'get', '/:id');
      await handler(req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent category', async () => {
      categoryRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'get', '/:id');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('PATCH /api/categories/:id', () => {
    it('should update category', async () => {
      categoryRepository.update.mockResolvedValue({ id: 1, general: 'UPDATED', detail: 'FOOD' });

      const req = { params: { id: '1' }, body: { general: 'updated' } };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'patch', '/:id');
      await handler(req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent category', async () => {
      categoryRepository.update.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { general: 'test' } };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'patch', '/:id');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /api/categories/:id', () => {
    it('should delete category and return success', async () => {
      categoryRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'delete', '/:id');
      await handler(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.message).toContain('deleted permanently');
    });

    it('should return 404 for non-existent category', async () => {
      categoryRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();

      const handler = getRouteHandler(categoryRoutes, 'delete', '/:id');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});

// Helpers
function mockResponse() {
  const res = {
    json: vi.fn(),
    status: vi.fn(),
    send: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

function getRouteHandler(router, method, path) {
  const layer = router.stack.find(
    l => l.route && l.route.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`No handler found for ${method.toUpperCase()} ${path}`);
  return layer.route.stack[0].handle;
}
