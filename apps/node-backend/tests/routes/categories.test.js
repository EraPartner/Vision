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
  get: vi.fn((path, ...handlers) => { routeHandlers[`get:${path}`] = handlers[handlers.length - 1]; }),
  post: vi.fn((path, ...handlers) => { routeHandlers[`post:${path}`] = handlers[handlers.length - 1]; }),
  patch: vi.fn((path, ...handlers) => { routeHandlers[`patch:${path}`] = handlers[handlers.length - 1]; }),
  delete: vi.fn((path, ...handlers) => { routeHandlers[`delete:${path}`] = handlers[handlers.length - 1]; }),
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
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler.js';

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
        ok: true,
        data: expect.objectContaining({ items: [], total: 0, limit: 50, offset: 0 }),
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
      expect(result.data.total).toBe(2);
      expect(result.data.items.length).toBe(2);
    });

    it('should respect pagination parameters', async () => {
      categoryRepository.getAll.mockResolvedValue([]);
      categoryRepository.getCount.mockResolvedValue(5);

      const req = { query: { limit: '2', offset: '1' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.data.limit).toBe(2);
      expect(result.data.offset).toBe(1);
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

    it('should throw ValidationError for missing fields', async () => {
      const req = { body: { general: 'groceries' } };
      const res = mockResponse();
      await expect(routeHandlers['post:/'](req, res)).rejects.toBeInstanceOf(ValidationError);
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

    it('should throw NotFoundError for non-existent', async () => {
      categoryRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await expect(routeHandlers['get:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
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

    it('should throw NotFoundError for non-existent', async () => {
      categoryRepository.update.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { general: 'test' } };
      const res = mockResponse();
      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('DELETE /:id', () => {
    it('should delete and return success message', async () => {
      categoryRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await routeHandlers['delete:/:id'](req, res);

      expect(res.json.mock.calls[0][0].data.message).toContain('deleted permanently');
    });

    it('should throw NotFoundError for non-existent', async () => {
      categoryRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('POST /:id/assign', () => {
    it('should assign category to recipients', async () => {
      categoryRepository.assignToRecipients.mockResolvedValue(2);

      const req = { params: { id: '1' }, body: { recipient_ids: [1, 2] } };
      const res = mockResponse();
      await routeHandlers['post:/:id/assign'](req, res);

      expect(res.json.mock.calls[0][0].data.updated_recipients).toBe(2);
    });

    it('should throw ValidationError for missing recipient_ids', async () => {
      const req = { params: { id: '1' }, body: {} };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/assign'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  // ── POST /assign (standalone by name) ──────────────────────
  describe('POST /assign (standalone)', () => {
    it('should assign category by general:detail name', async () => {
      categoryRepository.createOrGet.mockResolvedValue({
        category: { id: 5, general: 'GROCERIES', detail: 'FOOD' },
        created: false,
      });
      categoryRepository.assignToRecipients.mockResolvedValue(3);

      const req = { body: { category_general: 'GROCERIES', category_detail: 'FOOD', recipient_ids: [1, 2, 3] } };
      const res = mockResponse();
      await routeHandlers['post:/assign'](req, res);

      expect(res.json.mock.calls[0][0].data.updated_recipients).toBe(3);
    });

    it('should throw ValidationError for missing category_general', async () => {
      const req = { body: { category_detail: 'FOOD', recipient_ids: [1] } };
      const res = mockResponse();
      await expect(routeHandlers['post:/assign'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should throw ValidationError for missing category_detail', async () => {
      const req = { body: { category_general: 'GROCERIES', recipient_ids: [1] } };
      const res = mockResponse();
      await expect(routeHandlers['post:/assign'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should throw ValidationError for missing recipient_ids', async () => {
      const req = { body: { category_general: 'GROCERIES', category_detail: 'FOOD' } };
      const res = mockResponse();
      await expect(routeHandlers['post:/assign'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should handle single recipient_id (not array)', async () => {
      categoryRepository.createOrGet.mockResolvedValue({
        category: { id: 5, general: 'GROCERIES', detail: 'FOOD' },
        created: false,
      });
      categoryRepository.assignToRecipients.mockResolvedValue(1);

      const req = { body: { category_general: 'GROCERIES', category_detail: 'FOOD', recipient_ids: 42 } };
      const res = mockResponse();
      await routeHandlers['post:/assign'](req, res);

      expect(res.json.mock.calls[0][0].data.updated_recipients).toBe(1);
    });

    it('should propagate error when DB throws', async () => {
      categoryRepository.createOrGet.mockRejectedValue(new Error('DB error'));

      const req = { body: { category_general: 'GROCERIES', category_detail: 'FOOD', recipient_ids: [1] } };
      const res = mockResponse();
      await expect(routeHandlers['post:/assign'](req, res)).rejects.toThrow('DB error');
    });
  });

  // ── Error paths for existing routes ────────────────────────
  describe('Error handling', () => {
    it('GET / should propagate error when DB throws', async () => {
      categoryRepository.getAll.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await expect(routeHandlers['get:/'](req, res)).rejects.toThrow('DB error');
    });

    it('POST / should propagate error when DB throws', async () => {
      categoryRepository.createOrGet.mockRejectedValue(new Error('DB error'));

      const req = { body: { general: 'TEST', detail: 'TEST' } };
      const res = mockResponse();
      await expect(routeHandlers['post:/'](req, res)).rejects.toThrow('DB error');
    });

    it('GET /:id should propagate error when DB throws', async () => {
      categoryRepository.getById.mockRejectedValue(new Error('DB error'));

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await expect(routeHandlers['get:/:id'](req, res)).rejects.toThrow('DB error');
    });

    it('PATCH /:id should propagate error when DB throws', async () => {
      categoryRepository.update.mockRejectedValue(new Error('DB error'));

      const req = { params: { id: '1' }, body: { general: 'test' } };
      const res = mockResponse();
      await expect(routeHandlers['patch:/:id'](req, res)).rejects.toThrow('DB error');
    });

    it('DELETE /:id should propagate error when DB throws', async () => {
      categoryRepository.hardDelete.mockRejectedValue(new Error('DB error'));

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await expect(routeHandlers['delete:/:id'](req, res)).rejects.toThrow('DB error');
    });

    it('POST /:id/assign should propagate error when DB throws', async () => {
      categoryRepository.assignToRecipients.mockRejectedValue(new Error('DB error'));

      const req = { params: { id: '1' }, body: { recipient_ids: [1] } };
      const res = mockResponse();
      await expect(routeHandlers['post:/:id/assign'](req, res)).rejects.toThrow('DB error');
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  res.ok = (data, meta) => {
    const body = { ok: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };
  return res;
}
