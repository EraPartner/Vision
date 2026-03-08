/**
 * Category route tests.
 * Mirrors: apps/backend/tests/test_categories.py
 *
 * Uses mocked repository layer for unit testing.
 * Mocks express Router to avoid dependency issues.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock express Router
const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, handler) => { routeHandlers[`get:${path}`] = handler; }),
  post: vi.fn((path, handler) => { routeHandlers[`post:${path}`] = handler; }),
  patch: vi.fn((path, handler) => { routeHandlers[`patch:${path}`] = handler; }),
  delete: vi.fn((path, handler) => { routeHandlers[`delete:${path}`] = handler; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

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

// Import routes AFTER mocks are set up
await import('../../src/routes/categories.js');

describe('Category Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return empty list for empty database', async () => {
      categoryRepository.getAll.mockResolvedValue([]);
      categoryRepository.getCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      }));
    });

    it('should return categories with data', async () => {
      const categories = [
        { id: 1, general: 'GROCERIES', detail: 'FOOD' },
        { id: 2, general: 'TRANSPORT', detail: 'FUEL' },
      ];
      categoryRepository.getAll.mockResolvedValue(categories);
      categoryRepository.getCount.mockResolvedValue(2);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.total).toBe(2);
      expect(result.items.length).toBe(2);
    });

    it('should respect pagination parameters', async () => {
      categoryRepository.getAll.mockResolvedValue([]);
      categoryRepository.getCount.mockResolvedValue(5);

      const req = { query: { limit: '2', offset: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(1);
    });
  });

  describe('POST /', () => {
    it('should create new category with 201', async () => {
      categoryRepository.createOrGet.mockResolvedValue({
        category: { id: 1, general: 'GROCERIES', detail: 'FOOD' },
        created: true,
      });

      const req = { body: { general: 'groceries', detail: 'food' } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 200 for duplicate', async () => {
      categoryRepository.createOrGet.mockResolvedValue({
        category: { id: 1, general: 'GROCERIES', detail: 'FOOD' },
        created: false,
      });

      const req = { body: { general: 'groceries', detail: 'food' } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('should return 400 for missing fields', async () => {
      const req = { body: { general: 'groceries' } };
      const res = mockResponse();
      await routeHandlers['post:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /:id', () => {
    it('should return category by id', async () => {
      categoryRepository.getById.mockResolvedValue({ id: 1, general: 'GROCERIES', detail: 'FOOD' });

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/:id'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      categoryRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await routeHandlers['get:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('PATCH /:id', () => {
    it('should update category', async () => {
      categoryRepository.update.mockResolvedValue({ id: 1, general: 'UPDATED' });

      const req = { params: { id: '1' }, body: { general: 'updated' } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      categoryRepository.update.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { general: 'test' } };
      const res = mockResponse();
      await routeHandlers['patch:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /:id', () => {
    it('should delete and return success message', async () => {
      categoryRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.json.mock.calls[0][0].message).toContain('deleted permanently');
    });

    it('should return 404 for non-existent', async () => {
      categoryRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /:id/assign', () => {
    it('should assign category to recipients', async () => {
      categoryRepository.assignToRecipients.mockResolvedValue(2);

      const req = { params: { id: '1' }, body: { recipient_ids: [1, 2] } };
      const res = mockResponse();
      await routeHandlers['post:/:id/assign'](req, res);

      expect(res.json.mock.calls[0][0].updated_recipients).toBe(2);
    });

    it('should return 400 for missing recipient_ids', async () => {
      const req = { params: { id: '1' }, body: {} };
      const res = mockResponse();
      await routeHandlers['post:/:id/assign'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
