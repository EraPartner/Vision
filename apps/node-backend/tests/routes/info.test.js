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
      expect(infoRepository.getStatistics).toHaveBeenCalledWith('EUR');
    });

    it('should pass selected currency to repository', async () => {
      infoRepository.getStatistics.mockResolvedValue({ total_transactions: 0, categories: [] });

      const req = { query: { currency: 'HUF' } };
      const res = mockResponse();
      await routeHandlers['get:/'](req, res);

      expect(infoRepository.getStatistics).toHaveBeenCalledWith('HUF');
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
        bankAccount: 'Chase', startDate: '2026-01-01', endDate: '2026-12-31', targetCurrency: 'EUR',
      });
    });

    it('should pass selected currency for transaction summary', async () => {
      infoRepository.getTransactionSummary.mockResolvedValue({ total: 50 });

      const req = { query: { currency: 'AED', bank_account: 'Revolut' } };
      const res = mockResponse();
      await routeHandlers['get:/transaction-summary'](req, res);

      expect(infoRepository.getTransactionSummary).toHaveBeenCalledWith({
        bankAccount: 'Revolut',
        startDate: null,
        endDate: null,
        targetCurrency: 'AED',
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

  describe('GET /cashflow-comparison', () => {
    it('should return cashflow comparison data', async () => {
      infoRepository.getCashflowComparison.mockResolvedValue({
        days_in_month: 31, current_day: 15, month: 3, year: 2026,
        without_planned: Array.from({ length: 31 }, (_, i) => ({ day: i + 1, average: (i + 1) * 10, current: i < 15 ? (i + 1) * 9 : null })),
        with_planned: Array.from({ length: 31 }, (_, i) => ({ day: i + 1, average: (i + 1) * 11, current: i < 15 ? (i + 1) * 9.5 : null })),
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/cashflow-comparison'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.month).toBe(3);
      expect(result.days_in_month).toBe(31);
      expect(result.without_planned).toHaveLength(31);
      expect(result.with_planned).toHaveLength(31);
    });

    it('should handle errors', async () => {
      infoRepository.getCashflowComparison.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/cashflow-comparison'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /bank-balances', () => {
    it('should return bank balance data', async () => {
      infoRepository.getBankBalances.mockResolvedValue({
        accounts: [{ bank_account: 'Chase', balance: 5000, transaction_count: 100 }],
        total_net_position: 5000,
        history: {},
        total_history: [],
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/bank-balances'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.accounts).toHaveLength(1);
      expect(result.total_net_position).toBe(5000);
    });

    it('should handle errors', async () => {
      infoRepository.getBankBalances.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/bank-balances'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /net-worth', () => {
    it('should return net worth data with snapshots', async () => {
      infoRepository.getNetWorth.mockResolvedValue({
        current: { liquid: 10000, investments: 5000, netWorth: 15000 },
        monthlyChange: 500,
        monthlyChangePercent: 3.45,
        snapshots: [
          { date: '2026-03-01', liquid: 9000, investments: 4500, netWorth: 13500 },
          { date: '2026-03-02', liquid: 9500, investments: 5000, netWorth: 14500 },
          { date: '2026-03-03', liquid: 10000, investments: 5000, netWorth: 15000 },
        ],
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/net-worth'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.current.netWorth).toBe(15000);
      expect(result.monthlyChange).toBe(500);
      expect(result.snapshots).toHaveLength(3);
    });

    it('should return empty data when no assets', async () => {
      infoRepository.getNetWorth.mockResolvedValue({
        current: { liquid: 0, investments: 0, netWorth: 0 },
        monthlyChange: 0,
        monthlyChangePercent: 0,
        snapshots: [],
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/net-worth'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.current.netWorth).toBe(0);
      expect(result.snapshots).toHaveLength(0);
    });

    it('should handle errors', async () => {
      infoRepository.getNetWorth.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/net-worth'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /recipient-insights', () => {
    it('should return top merchants and month-over-month data', async () => {
      infoRepository.getRecipientInsights.mockResolvedValue({
        topMerchants: [
          { recipientId: 1, name: 'Amazon', totalSpend: 500, transactionCount: 10, avgAmount: 50, firstSeen: '2025-01-01', lastSeen: '2026-03-01' },
          { recipientId: 2, name: 'Walmart', totalSpend: 300, transactionCount: 8, avgAmount: 37.5, firstSeen: '2025-06-01', lastSeen: '2026-03-01' },
        ],
        monthOverMonth: [
          { recipientId: 1, name: 'Amazon', currentSpend: 100, previousSpend: 80, changePercent: 25.0 },
        ],
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/recipient-insights'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.topMerchants).toHaveLength(2);
      expect(result.topMerchants[0].name).toBe('Amazon');
      expect(result.monthOverMonth).toHaveLength(1);
      expect(result.monthOverMonth[0].changePercent).toBe(25.0);
    });

    it('should return empty arrays when no data', async () => {
      infoRepository.getRecipientInsights.mockResolvedValue({
        topMerchants: [],
        monthOverMonth: [],
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/recipient-insights'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.topMerchants).toEqual([]);
      expect(result.monthOverMonth).toEqual([]);
    });

    it('should handle errors', async () => {
      infoRepository.getRecipientInsights.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/recipient-insights'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
