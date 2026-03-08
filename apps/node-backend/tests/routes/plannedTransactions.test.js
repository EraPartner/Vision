/**
 * Planned transaction route tests.
 * Mirrors: apps/backend/tests/test_planned_transactions.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/plannedTransactionRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
    addExecution: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import plannedTransactionRepository from '../../src/repositories/plannedTransactionRepository.js';
import plannedRoutes from '../../src/routes/plannedTransactions.js';

describe('Planned Transaction Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return empty list', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 0 });

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'get', '/')(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return planned transactions with data', async () => {
      const items = [
        { id: 1, planned_date: '2026-03-15', amount: '50.00', bank_account: 'Chase', is_recurring: false, is_executed: false },
      ];
      plannedTransactionRepository.getAll.mockResolvedValue({ items, total: 1 });

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'get', '/')(req, res);

      expect(res.json.mock.calls[0][0].total).toBe(1);
    });

    it('should respect pagination', async () => {
      plannedTransactionRepository.getAll.mockResolvedValue({ items: [], total: 10 });

      const req = { query: { limit: '5', offset: '2' } };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'get', '/')(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.limit).toBe(5);
      expect(result.offset).toBe(2);
    });
  });

  describe('POST /', () => {
    it('should create planned transaction with 201', async () => {
      plannedTransactionRepository.create.mockResolvedValue({
        id: 1, planned_date: '2026-03-15', amount: '50.00', bank_account: 'Chase',
        is_recurring: false, is_executed: false,
      });

      const req = {
        body: { planned_date: '2026-03-15', bank_account: 'Chase', amount: 50.00 },
      };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'post', '/')(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 400 for missing fields', async () => {
      const req = { body: { amount: 50 } };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'post', '/')(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /:id', () => {
    it('should return planned transaction by id', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({
        id: 1, planned_date: '2026-03-15', amount: '50.00',
      });

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'get', '/:id')(req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'get', '/:id')(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('PATCH /:id', () => {
    it('should update planned transaction', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({ id: 1 });
      plannedTransactionRepository.update.mockResolvedValue({
        id: 1, planned_date: '2026-04-15', amount: '75.00',
      });

      const req = { params: { id: '1' }, body: { amount: 75.00 } };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'patch', '/:id')(req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { amount: 75 } };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'patch', '/:id')(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /:id/execute', () => {
    it('should execute one-time planned transaction', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({
        id: 1, is_recurring: false, is_executed: false,
      });
      plannedTransactionRepository.addExecution.mockResolvedValue({});
      plannedTransactionRepository.update.mockResolvedValue({
        id: 1, is_executed: true, last_executed_date: '2026-03-15',
      });

      const req = {
        params: { id: '1' },
        body: { executed_transaction_id: 10, execution_date: '2026-03-15' },
      };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'post', '/:id/execute')(req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should execute recurring and advance date', async () => {
      plannedTransactionRepository.getById.mockResolvedValue({
        id: 1, is_recurring: true, recurrence_pattern: 'monthly',
        planned_date: '2026-03-15', is_executed: false,
      });
      plannedTransactionRepository.addExecution.mockResolvedValue({});
      plannedTransactionRepository.update.mockResolvedValue({
        id: 1, is_executed: false, planned_date: '2026-04-15',
      });

      const req = {
        params: { id: '1' },
        body: { executed_transaction_id: 10 },
      };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'post', '/:id/execute')(req, res);

      // Verify update was called with advanced date
      const updateCall = plannedTransactionRepository.update.mock.calls[0];
      expect(updateCall[1].is_executed).toBe(false); // recurring stays false
    });

    it('should return 400 without executed_transaction_id', async () => {
      const req = { params: { id: '1' }, body: {} };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'post', '/:id/execute')(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { executed_transaction_id: 10 } };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'post', '/:id/execute')(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /:id', () => {
    it('should delete planned transaction', async () => {
      plannedTransactionRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'delete', '/:id')(req, res);

      expect(res.json.mock.calls[0][0].message).toContain('deleted permanently');
    });

    it('should return 404 for non-existent', async () => {
      plannedTransactionRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await getRouteHandler(plannedRoutes, 'delete', '/:id')(req, res);

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
