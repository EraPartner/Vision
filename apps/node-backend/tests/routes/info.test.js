/**
 * Info/Statistics route tests.
 * Mirrors: apps/backend/tests/test_info.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/infoRepository.js', () => ({
  default: {
    getStatistics: vi.fn(),
    getBanks: vi.fn(),
    getTransactionCount: vi.fn(),
    getTransactionSummary: vi.fn(),
    getMonthlyFinancialSummary: vi.fn(),
    getPlannedExpensesNextMonth: vi.fn(),
    getAverageVsCurrentSpending: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import infoRepository from '../../src/repositories/infoRepository.js';
import infoRoutes from '../../src/routes/info.js';

describe('Info Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return statistics', async () => {
      infoRepository.getStatistics.mockResolvedValue({
        total_transactions: 5, categories: [{ name: 'FOOD', count: 3 }],
      });

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/')(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.total_transactions).toBe(5);
    });

    it('should return empty stats for empty database', async () => {
      infoRepository.getStatistics.mockResolvedValue({
        total_transactions: 0, categories: [],
      });

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/')(req, res);

      expect(res.json.mock.calls[0][0].total_transactions).toBe(0);
    });

    it('should handle database errors', async () => {
      infoRepository.getStatistics.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/')(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /banks', () => {
    it('should return bank list', async () => {
      infoRepository.getBanks.mockResolvedValue(['Chase', 'Revolut', 'Barclays']);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/banks')(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.banks).toHaveLength(3);
    });

    it('should return empty for no banks', async () => {
      infoRepository.getBanks.mockResolvedValue([]);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/banks')(req, res);

      expect(res.json.mock.calls[0][0].banks).toEqual([]);
    });

    it('should handle database errors', async () => {
      infoRepository.getBanks.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/banks')(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /transaction-count', () => {
    it('should return count', async () => {
      infoRepository.getTransactionCount.mockResolvedValue(42);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/transaction-count')(req, res);

      expect(res.json.mock.calls[0][0].total_transactions).toBe(42);
    });

    it('should return 0 for empty database', async () => {
      infoRepository.getTransactionCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/transaction-count')(req, res);

      expect(res.json.mock.calls[0][0].total_transactions).toBe(0);
    });

    it('should handle database errors', async () => {
      infoRepository.getTransactionCount.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/transaction-count')(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /transaction-summary', () => {
    it('should return summary', async () => {
      infoRepository.getTransactionSummary.mockResolvedValue({ total: 100 });

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/transaction-summary')(req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should pass filters', async () => {
      infoRepository.getTransactionSummary.mockResolvedValue({ total: 50 });

      const req = { query: { bank_account: 'Chase', start_date: '2026-01-01', end_date: '2026-12-31' } };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/transaction-summary')(req, res);

      expect(infoRepository.getTransactionSummary).toHaveBeenCalledWith({
        bankAccount: 'Chase',
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
    });

    it('should handle database errors', async () => {
      infoRepository.getTransactionSummary.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/transaction-summary')(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /monthly-summary', () => {
    it('should return monthly summary', async () => {
      infoRepository.getMonthlyFinancialSummary.mockResolvedValue({ months: [] });

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/monthly-summary')(req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should handle database errors', async () => {
      infoRepository.getMonthlyFinancialSummary.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/monthly-summary')(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /supported-adapters', () => {
    it('should return supported bank adapters', async () => {
      const req = { query: {} };
      const res = mockResponse();
      await getRouteHandler(infoRoutes, 'get', '/supported-adapters')(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.adapters).toBeDefined();
      expect(result.total_count).toBeGreaterThan(0);
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
