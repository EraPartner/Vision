/**
 * Category route tests.
 * Mirrors: apps/backend/tests/test_categories.py
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js) — validateIdParam is no longer stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, okEnvelope, errEnvelope } from '../helpers/routeApp.js';

// The route imports its repository through services/categoryService.js, which
// re-exports the default from this module (`export { default } from
// '../repositories/categoryRepository.js'`) — mocking the repository here
// intercepts that same binding.
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

vi.mock('../../src/services/materializedViewService.js', () => ({
  scheduleRefresh: vi.fn(),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import categoryRepository from '../../src/repositories/categoryRepository.js';

const { default: categoriesRouter } = await import('../../src/routes/categories.js');

const api = routeAgent(categoriesRouter, { mountPath: '/api/categories' });
const BASE = '/api/categories';

describe('Category Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return empty list for empty database', async () => {
      categoryRepository.getAll.mockResolvedValue([]);
      categoryRepository.getCount.mockResolvedValue(0);

      const res = await api.get(BASE).expect(200);

      expect(res.body).toEqual(expect.objectContaining({
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

      const res = await api.get(BASE).expect(200);

      expect(res.body.data.total).toBe(2);
      expect(res.body.data.items.length).toBe(2);
    });

    it('should respect pagination parameters', async () => {
      categoryRepository.getAll.mockResolvedValue([]);
      categoryRepository.getCount.mockResolvedValue(5);

      const res = await api.get(`${BASE}?limit=2&offset=1`).expect(200);

      expect(res.body.data.limit).toBe(2);
      expect(res.body.data.offset).toBe(1);
    });
  });

  describe('POST /', () => {
    it('should create new category with 201', async () => {
      categoryRepository.createOrGet.mockResolvedValue({
        category: { id: 1, general: 'GROCERIES', detail: 'FOOD' },
        created: true,
      });

      await api.post(BASE).send({ general: 'groceries', detail: 'food' }).expect(201);
    });

    it('should return 200 for duplicate', async () => {
      categoryRepository.createOrGet.mockResolvedValue({
        category: { id: 1, general: 'GROCERIES', detail: 'FOOD' },
        created: false,
      });

      await api.post(BASE).send({ general: 'groceries', detail: 'food' }).expect(200);
    });

    it('should return a 400 VALIDATION_ERROR envelope for missing fields', async () => {
      const res = await api.post(BASE).send({ general: 'groceries' }).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });
  });

  describe('GET /:id', () => {
    it('should return category by id', async () => {
      categoryRepository.getById.mockResolvedValue({ id: 1, general: 'GROCERIES', detail: 'FOOD' });

      const res = await api.get(`${BASE}/1`).expect(200);
      expect(res.body.data.id).toBe(1);
    });

    it('should return a 404 NOT_FOUND envelope for non-existent', async () => {
      categoryRepository.getById.mockResolvedValue(null);

      const res = await api.get(`${BASE}/99999`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });

    it('rejects a non-integer :id via the real validateIdParam guard', async () => {
      // Previously `vi.mock('.../middleware/validation.js')` replaced
      // validateIdParam with a pass-through, so this guard was never tested.
      const res = await api.get(`${BASE}/abc`).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
      expect(categoryRepository.getById).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id', () => {
    it('should update category', async () => {
      categoryRepository.update.mockResolvedValue({ id: 1, general: 'UPDATED' });

      const res = await api.patch(`${BASE}/1`).send({ general: 'updated' }).expect(200);
      expect(res.body.data.general).toBe('UPDATED');
    });

    it('should return a 404 NOT_FOUND envelope for non-existent', async () => {
      categoryRepository.update.mockResolvedValue(null);

      const res = await api.patch(`${BASE}/99999`).send({ general: 'test' }).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });
  });

  describe('DELETE /:id', () => {
    it('should delete and return 204 with no body', async () => {
      categoryRepository.hardDelete.mockResolvedValue(true);

      const res = await api.delete(`${BASE}/1`).expect(204);
      expect(res.text).toBe('');
    });

    it('should return a 404 NOT_FOUND envelope for non-existent', async () => {
      categoryRepository.hardDelete.mockResolvedValue(false);

      const res = await api.delete(`${BASE}/99999`).expect(404);
      expect(res.body).toEqual(errEnvelope({ code: 'NOT_FOUND' }));
    });
  });

  describe('POST /:id/assign', () => {
    it('should assign category to recipients', async () => {
      categoryRepository.assignToRecipients.mockResolvedValue(2);

      const res = await api.post(`${BASE}/1/assign`).send({ recipient_ids: [1, 2] }).expect(200);
      expect(res.body.data.updated_recipients).toBe(2);
    });

    it('should return a 400 VALIDATION_ERROR envelope for missing recipient_ids', async () => {
      const res = await api.post(`${BASE}/1/assign`).send({}).expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
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

      const res = await api.post(`${BASE}/assign`)
        .send({ category_general: 'GROCERIES', category_detail: 'FOOD', recipient_ids: [1, 2, 3] })
        .expect(200);
      expect(res.body.data.updated_recipients).toBe(3);
    });

    it('should return a 400 VALIDATION_ERROR envelope for missing category_general', async () => {
      const res = await api.post(`${BASE}/assign`)
        .send({ category_detail: 'FOOD', recipient_ids: [1] })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should return a 400 VALIDATION_ERROR envelope for missing category_detail', async () => {
      const res = await api.post(`${BASE}/assign`)
        .send({ category_general: 'GROCERIES', recipient_ids: [1] })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should return a 400 VALIDATION_ERROR envelope for missing recipient_ids', async () => {
      const res = await api.post(`${BASE}/assign`)
        .send({ category_general: 'GROCERIES', category_detail: 'FOOD' })
        .expect(400);
      expect(res.body).toEqual(errEnvelope({ code: 'VALIDATION_ERROR' }));
    });

    it('should handle single recipient_id (not array)', async () => {
      categoryRepository.createOrGet.mockResolvedValue({
        category: { id: 5, general: 'GROCERIES', detail: 'FOOD' },
        created: false,
      });
      categoryRepository.assignToRecipients.mockResolvedValue(1);

      const res = await api.post(`${BASE}/assign`)
        .send({ category_general: 'GROCERIES', category_detail: 'FOOD', recipient_ids: 42 })
        .expect(200);
      expect(res.body.data.updated_recipients).toBe(1);
    });

    it('should propagate a 500 when the DB throws', async () => {
      categoryRepository.createOrGet.mockRejectedValue(new Error('DB error'));

      const res = await api.post(`${BASE}/assign`)
        .send({ category_general: 'GROCERIES', category_detail: 'FOOD', recipient_ids: [1] })
        .expect(500);
      expect(res.body.error.message).toBe('DB error');
    });
  });

  // ── Error paths for existing routes ────────────────────────
  describe('Error handling', () => {
    it('GET / should answer a 500 when the DB throws', async () => {
      categoryRepository.getAll.mockRejectedValue(new Error('DB error'));

      const res = await api.get(BASE).expect(500);
      expect(res.body.error.message).toBe('DB error');
    });

    it('POST / should answer a 500 when the DB throws', async () => {
      categoryRepository.createOrGet.mockRejectedValue(new Error('DB error'));

      const res = await api.post(BASE).send({ general: 'TEST', detail: 'TEST' }).expect(500);
      expect(res.body.error.message).toBe('DB error');
    });

    it('GET /:id should answer a 500 when the DB throws', async () => {
      categoryRepository.getById.mockRejectedValue(new Error('DB error'));

      const res = await api.get(`${BASE}/1`).expect(500);
      expect(res.body.error.message).toBe('DB error');
    });

    it('PATCH /:id should answer a 500 when the DB throws', async () => {
      categoryRepository.update.mockRejectedValue(new Error('DB error'));

      const res = await api.patch(`${BASE}/1`).send({ general: 'test' }).expect(500);
      expect(res.body.error.message).toBe('DB error');
    });

    it('DELETE /:id should answer a 500 when the DB throws', async () => {
      categoryRepository.hardDelete.mockRejectedValue(new Error('DB error'));

      const res = await api.delete(`${BASE}/1`).expect(500);
      expect(res.body.error.message).toBe('DB error');
    });

    it('POST /:id/assign should answer a 500 when the DB throws', async () => {
      categoryRepository.assignToRecipients.mockRejectedValue(new Error('DB error'));

      const res = await api.post(`${BASE}/1/assign`).send({ recipient_ids: [1] }).expect(500);
      expect(res.body.error.message).toBe('DB error');
    });
  });
});
