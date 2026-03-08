/**
 * Transaction route tests.
 * Mirrors: apps/backend/tests/test_transactions.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/transactionRepository.js', () => ({
  default: {
    getAll: vi.fn(),
    getUncategorised: vi.fn(),
    getCount: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    hardDelete: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import transactionRepository from '../../src/repositories/transactionRepository.js';
import transactionRoutes from '../../src/routes/transactions.js';

describe('Transaction Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return empty list', async () => {
      transactionRepository.getAll.mockResolvedValue([]);
      transactionRepository.getCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'get', '/')(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return transactions with data', async () => {
      const txns = [
        { id: 1, date: '2026-01-15', bank_account: 'Chase', amount: '25.50', recipient_id: 1 },
      ];
      transactionRepository.getAll.mockResolvedValue(txns);
      transactionRepository.getCount.mockResolvedValue(1);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'get', '/')(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.total).toBe(1);
      expect(result.items[0].amount).toBe(25.5);
    });

    it('should respect pagination', async () => {
      transactionRepository.getAll.mockResolvedValue([]);
      transactionRepository.getCount.mockResolvedValue(10);

      const req = { query: { limit: '2', offset: '3' } };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'get', '/')(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(3);
    });
  });

  describe('GET /:id', () => {
    it('should return transaction by id', async () => {
      transactionRepository.getById.mockResolvedValue({
        id: 1, date: '2026-01-15', amount: '50.00', bank_account: 'Chase',
      });

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'get', '/:id')(req, res);

      expect(res.json).toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].amount).toBe(50);
    });

    it('should return 404 for non-existent', async () => {
      transactionRepository.getById.mockResolvedValue(null);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'get', '/:id')(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('POST /', () => {
    it('should create transaction with 201', async () => {
      transactionRepository.create.mockResolvedValue({
        id: 1, date: '2026-01-15', amount: '-50.00', bank_account: 'Chase',
        recipient_id: 1, memo: 'Test',
      });

      const req = {
        body: {
          transaction_date: '2026-01-15',
          bank_account: 'Chase',
          recipient_id: 1,
          amount: -50.00,
          memo: 'Test',
        },
      };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'post', '/')(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should return 400 for missing fields', async () => {
      const req = { body: { bank_account: 'Chase', amount: -50.00 } };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'post', '/')(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('PATCH /:id', () => {
    it('should update transaction', async () => {
      transactionRepository.update.mockResolvedValue({
        id: 1, date: '2026-01-15', amount: '-75.00', bank_account: 'Chase',
      });

      const req = { params: { id: '1' }, body: { amount: -75.00 } };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'patch', '/:id')(req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should return 404 for non-existent', async () => {
      transactionRepository.update.mockResolvedValue(null);

      const req = { params: { id: '99999' }, body: { amount: -75.00 } };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'patch', '/:id')(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('DELETE /:id', () => {
    it('should delete and return success', async () => {
      transactionRepository.hardDelete.mockResolvedValue(true);

      const req = { params: { id: '1' } };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'delete', '/:id')(req, res);

      expect(res.json.mock.calls[0][0].message).toContain('deleted permanently');
    });

    it('should return 404 for non-existent', async () => {
      transactionRepository.hardDelete.mockResolvedValue(false);

      const req = { params: { id: '99999' } };
      const res = mockResponse();
      await getRouteHandler(transactionRoutes, 'delete', '/:id')(req, res);

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
