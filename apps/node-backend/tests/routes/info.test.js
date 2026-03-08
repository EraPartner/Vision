/**
 * Info/Statistics route tests.
 * Mirrors: apps/backend/tests/test_info.py
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

vi.mock('../../src/repositories/infoRepository.js', () => ({
  default: {
    getStatistics: vi.fn(),
    getBanks: vi.fn(),
    getTransactionCount: vi.fn(),
    getTransactionSummary: vi.fn(),
    getMonthlyFinancialSummary: vi.fn(),
    getPlannedExpensesNextMonth: vi.fn(),
    getAverageVsCurrentSpending: vi.fn(),
    getCashflowComparison: vi.fn(),
    getBankBalances: vi.fn(),
    getNetWorth: vi.fn(),
    getRecipientInsights: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import infoRepository from '../../src/repositories/infoRepository.js';
await import('../../src/routes/info.js');

describe('Info Routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('GET /', () => {
    it('should return statistics', async () => {
      infoRepository.getStatistics.mockResolvedValue({
        total_transactions: 5, categories: [{ name: 'FOOD', count: 3 }],
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].total_transactions).toBe(5);
    });

    it('should return empty for empty database', async () => {
      infoRepository.getStatistics.mockResolvedValue({ total_transactions: 0, categories: [] });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.json.mock.calls[0][0].total_transactions).toBe(0);
    });

    it('should handle database errors', async () => {
      infoRepository.getStatistics.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /banks', () => {
    it('should return bank list', async () => {
      infoRepository.getBanks.mockResolvedValue(['Chase', 'Revolut']);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/banks'](req, res);

      expect(res.json.mock.calls[0][0].banks).toHaveLength(2);
    });

    it('should return empty for no banks', async () => {
      infoRepository.getBanks.mockResolvedValue([]);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/banks'](req, res);

      expect(res.json.mock.calls[0][0].banks).toEqual([]);
    });

    it('should handle database errors', async () => {
      infoRepository.getBanks.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/banks'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /transaction-count', () => {
    it('should return count', async () => {
      infoRepository.getTransactionCount.mockResolvedValue(42);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/transaction-count'](req, res);

      expect(res.json.mock.calls[0][0].total_transactions).toBe(42);
    });

    it('should return 0 for empty', async () => {
      infoRepository.getTransactionCount.mockResolvedValue(0);

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/transaction-count'](req, res);

      expect(res.json.mock.calls[0][0].total_transactions).toBe(0);
    });

    it('should handle errors', async () => {
      infoRepository.getTransactionCount.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/transaction-count'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /transaction-summary', () => {
    it('should return summary', async () => {
      infoRepository.getTransactionSummary.mockResolvedValue({ total: 100 });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/transaction-summary'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should pass filters', async () => {
      infoRepository.getTransactionSummary.mockResolvedValue({ total: 50 });

      const req = { query: { bank_account: 'Chase', start_date: '2026-01-01', end_date: '2026-12-31' } };
      const res = mockResponse();
      await routeHandlers['get:/transaction-summary'](req, res);

      expect(infoRepository.getTransactionSummary).toHaveBeenCalledWith({
        bankAccount: 'Chase', startDate: '2026-01-01', endDate: '2026-12-31',
      });
    });

    it('should handle errors', async () => {
      infoRepository.getTransactionSummary.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/transaction-summary'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /monthly-summary', () => {
    it('should return monthly summary', async () => {
      infoRepository.getMonthlyFinancialSummary.mockResolvedValue({ months: [] });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/monthly-summary'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should handle errors', async () => {
      infoRepository.getMonthlyFinancialSummary.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/monthly-summary'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /supported-adapters', () => {
    it('should return supported adapters', async () => {
      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/supported-adapters'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.adapters).toBeDefined();
      expect(result.total_count).toBeGreaterThan(0);
    });
  });

  describe('GET /planned-expenses-next-month', () => {
    it('should return planned expenses', async () => {
      infoRepository.getPlannedExpensesNextMonth.mockResolvedValue({ total: 500 });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/planned-expenses-next-month'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should handle errors', async () => {
      infoRepository.getPlannedExpensesNextMonth.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/planned-expenses-next-month'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /average-vs-current-spending', () => {
    it('should return comparison data', async () => {
      infoRepository.getAverageVsCurrentSpending.mockResolvedValue({ avg: 200, current: 250 });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/average-vs-current-spending'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('should handle errors', async () => {
      infoRepository.getAverageVsCurrentSpending.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/average-vs-current-spending'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
