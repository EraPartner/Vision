/**
 * Info/Statistics route tests.
 * Mirrors: apps/backend/tests/test_info.py
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...handlers) => { routeHandlers[`get:${path}`] = handlers[handlers.length - 1]; }),
  post: vi.fn((path, ...handlers) => { routeHandlers[`post:${path}`] = handlers[handlers.length - 1]; }),
  use: vi.fn(),
};

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/repositories/infoRepository.js', () => ({
  default: {
    getStatistics: vi.fn(),
    getCategoryBreakdown: vi.fn(),
    getBanks: vi.fn(),
    getTransactionCount: vi.fn(),
    getTransactionSummary: vi.fn(),
    getMonthlyFinancialSummary: vi.fn(),
    getPlannedExpensesNextMonth: vi.fn(),
    getAverageVsCurrentSpending: vi.fn(),
    getCashflowComparison: vi.fn(),
    getBankBalances: vi.fn(),
    getNetWorthFromSnapshots: vi.fn(),
    getRecipientInsights: vi.fn(),
  },
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockInflationService = {
  getInflationRates: vi.fn(),
  clearInflationMemoryCache: vi.fn(),
};

vi.mock('../../src/services/belgianInflationService.js', () => mockInflationService);

const mockDbQuery = vi.fn();
const mockDetectRecurringPatterns = vi.fn();
const mockRefreshMaterializedViews = vi.fn();
const mockWarmCache = vi.fn();
const mockClearMemoryCache = vi.fn();
const mockGetSnapshots = vi.fn();

vi.mock('../../src/database/connection.js', () => ({
  query: mockDbQuery,
}));

vi.mock('../../src/services/recurringDetectionService.js', () => ({
  detectRecurringPatterns: mockDetectRecurringPatterns,
}));

vi.mock('../../src/services/materializedViewService.js', () => ({
  refreshMaterializedViews: mockRefreshMaterializedViews,
}));

vi.mock('../../src/services/currencyConversionService.js', () => ({
  FALLBACK_RATES: { USD: 1.1 },
  warmCache: mockWarmCache,
  clearMemoryCache: mockClearMemoryCache,
}));

vi.mock('../../src/services/portfolioPerformanceSnapshotService.js', () => ({
  getSnapshots: mockGetSnapshots,
  computeMetrics: vi.fn(() => ({
    currentValue: 0, totalInvested: 0, totalGainLoss: 0,
    totalReturnPct: 0, annualizedReturn: 0, realReturnPct: 0, cumulativeInflation: 0,
  })),
  computeHeatmap: vi.fn(() => ({ years: [], data: {}, maxAbsPct: 0 })),
  getBreakdownSummary: vi.fn(async () => []),
}));

import infoRepository from '../../src/repositories/infoRepository.js';
import { logger } from '../../src/config/logger.js';
const { warmInfoCaches } = await import('../../src/routes/info.js');

describe('Info Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWarmCache.mockResolvedValue(undefined);
    mockRefreshMaterializedViews.mockResolvedValue(undefined);
    mockDetectRecurringPatterns.mockResolvedValue({ patterns: [], total: 0 });
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockGetSnapshots.mockResolvedValue([]);
  });

  it('should register /refresh-views and /inflation-rates/refresh routes', () => {
    expect(routeHandlers['post:/refresh-views']).toBeTypeOf('function');
    expect(routeHandlers['post:/inflation-rates/refresh']).toBeTypeOf('function');
  });

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

  describe('GET /category-breakdown', () => {
    it('should return category list with links', async () => {
      infoRepository.getCategoryBreakdown.mockResolvedValue([
        { id: 1, name: 'FOOD:GROCERIES', count: 3, total: -120.55 },
      ]);

      const req = { query: { currency: 'EUR' } };
      const res = mockResponse();
      await routeHandlers['get:/category-breakdown'](req, res);

      expect(infoRepository.getCategoryBreakdown).toHaveBeenCalledWith('EUR');
      expect(res.json).toHaveBeenCalledWith({
        categories: [{ id: 1, name: 'FOOD:GROCERIES', count: 3, total: -120.55 }],
        links: [],
      });
    });

    it('should handle category breakdown errors', async () => {
      infoRepository.getCategoryBreakdown.mockRejectedValue(new Error('DB error'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/category-breakdown'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /net-worth', () => {
    it('should return net worth data with snapshots', async () => {
      infoRepository.getNetWorthFromSnapshots.mockResolvedValue({
        current: { liquid: 10000, investments: 5000, netWorth: 15000 },
        monthlyChange: 500,
        monthlyChangePercent: 3.45,
        snapshots: [
          { date: '2026-03-01', liquid: 9000, investments: 4500, netWorth: 13500 },
          { date: '2026-03-02', liquid: 9500, investments: 5000, netWorth: 14500 },
          { date: '2026-03-03', liquid: 10000, investments: 5000, netWorth: 15000 },
        ],
      });

      const req = { query: { currency: 'EUR' } };
      const res = mockResponse();
      await routeHandlers['get:/net-worth'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.current.netWorth).toBe(15000);
      expect(result.monthlyChange).toBe(500);
      expect(result.snapshots).toHaveLength(3);
    });

    it('should return empty data when no assets', async () => {
      infoRepository.getNetWorthFromSnapshots.mockResolvedValue({
        current: { liquid: 0, investments: 0, netWorth: 0 },
        monthlyChange: 0,
        monthlyChangePercent: 0,
        snapshots: [],
      });

      const req = { query: { currency: 'USD' } };
      const res = mockResponse();
      await routeHandlers['get:/net-worth'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.current.netWorth).toBe(0);
      expect(result.snapshots).toHaveLength(0);
    });

    it('should handle errors', async () => {
      infoRepository.getNetWorthFromSnapshots.mockRejectedValue(new Error('DB error'));

      const req = { query: { currency: 'GBP' } };
      const res = mockResponse();
      await routeHandlers['get:/net-worth'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('should paginate snapshots newest-first when limit/offset supplied', async () => {
      infoRepository.getNetWorthFromSnapshots.mockResolvedValue({
        current: { liquid: 10000, investments: 5000, netWorth: 15000 },
        monthlyChange: 0,
        monthlyChangePercent: 0,
        snapshots: [
          { date: '2026-03-01', liquid: 1, investments: 1, netWorth: 2 },
          { date: '2026-03-02', liquid: 2, investments: 2, netWorth: 4 },
          { date: '2026-03-03', liquid: 3, investments: 3, netWorth: 6 },
          { date: '2026-03-04', liquid: 4, investments: 4, netWorth: 8 },
          { date: '2026-03-05', liquid: 5, investments: 5, netWorth: 10 },
        ],
      });

      const req = { query: { currency: 'AUD', limit: '2', offset: '0' } };
      const res = mockResponse();
      await routeHandlers['get:/net-worth'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots[0].date).toBe('2026-03-05');
      expect(result.snapshots[1].date).toBe('2026-03-04');
      expect(result.snapshotsTotal).toBe(5);
    });

    it('should honor offset for pagination', async () => {
      infoRepository.getNetWorthFromSnapshots.mockResolvedValue({
        current: { liquid: 0, investments: 0, netWorth: 0 },
        monthlyChange: 0,
        monthlyChangePercent: 0,
        snapshots: [
          { date: '2026-03-01', liquid: 1, investments: 1, netWorth: 2 },
          { date: '2026-03-02', liquid: 2, investments: 2, netWorth: 4 },
          { date: '2026-03-03', liquid: 3, investments: 3, netWorth: 6 },
          { date: '2026-03-04', liquid: 4, investments: 4, netWorth: 8 },
        ],
      });

      const req = { query: { currency: 'CAD', limit: '2', offset: '2' } };
      const res = mockResponse();
      await routeHandlers['get:/net-worth'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots[0].date).toBe('2026-03-02');
      expect(result.snapshots[1].date).toBe('2026-03-01');
      expect(result.snapshotsTotal).toBe(4);
    });

    it('should return full unpaginated history when no limit/offset params', async () => {
      infoRepository.getNetWorthFromSnapshots.mockResolvedValue({
        current: { liquid: 0, investments: 0, netWorth: 0 },
        monthlyChange: 0,
        monthlyChangePercent: 0,
        snapshots: [
          { date: '2026-03-01', liquid: 1, investments: 1, netWorth: 2 },
          { date: '2026-03-02', liquid: 2, investments: 2, netWorth: 4 },
        ],
      });

      const req = { query: { currency: 'CHF' } };
      const res = mockResponse();
      await routeHandlers['get:/net-worth'](req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots[0].date).toBe('2026-03-01');
      expect(result.snapshotsTotal).toBeUndefined();
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

  describe('GET /recurring-patterns', () => {
    it('should return recurring patterns payload', async () => {
      mockDetectRecurringPatterns.mockResolvedValue({
        patterns: [{ recipient: 'Netflix', interval_days: 30 }],
        total: 1,
      });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/recurring-patterns'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        patterns: [{ recipient: 'Netflix', interval_days: 30 }],
        total: 1,
      });
    });

    it('should return empty recurring payload when detector fails', async () => {
      mockDetectRecurringPatterns.mockRejectedValue(new Error('detector failed'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/recurring-patterns'](req, res);

      expect(logger.error).toHaveBeenCalledWith(
        'Error detecting recurring patterns; returning empty result',
        expect.objectContaining({ error: 'detector failed' })
      );
      expect(res.json).toHaveBeenCalledWith({ patterns: [], total: 0 });
    });
  });

  describe('GET /exchange-rates', () => {
    it('should return mapped rates and trigger background refresh when stale', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        mockDbQuery.mockResolvedValue({
          rows: [
            {
              currency_code: 'USD',
              rate_to_eur: '1.2345',
              rate_date: '2026-04-10',
              fetched_at: '2026-04-10T08:30:00.000Z',
            },
          ],
        });

        const req = { query: {} };
        const res = mockResponse();
        await routeHandlers['get:/exchange-rates'](req, res);

        expect(mockClearMemoryCache).toHaveBeenCalledTimes(1);
        expect(mockWarmCache).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith({
          total_rates: 1,
          rates: [
            {
              currency: 'USD',
              rate_to_eur: 1.2345,
              rate_date: '2026-04-10',
              fetched_at: '2026-04-10T08:30:00.000Z',
            },
          ],
          fallback_rates: { USD: 1.1 },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not trigger background refresh when rates are current', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        mockDbQuery.mockResolvedValue({
          rows: [
            {
              currency_code: 'GBP',
              rate_to_eur: '0.89',
              rate_date: new Date('2026-04-11T00:00:00.000Z'),
              fetched_at: '2026-04-11T01:00:00.000Z',
            },
          ],
        });

        const req = { query: {} };
        const res = mockResponse();
        await routeHandlers['get:/exchange-rates'](req, res);

        expect(mockClearMemoryCache).not.toHaveBeenCalled();
        expect(mockWarmCache).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            total_rates: 1,
            rates: [expect.objectContaining({ currency: 'GBP', rate_date: '2026-04-11' })],
          })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('should log warning when background refresh fails', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        mockDbQuery.mockResolvedValue({
          rows: [
            {
              currency_code: 'USD',
              rate_to_eur: '1.2',
              rate_date: '2026-04-10',
              fetched_at: '2026-04-10T08:30:00.000Z',
            },
          ],
        });
        mockWarmCache.mockRejectedValueOnce(new Error('refresh failed'));

        const req = { query: {} };
        const res = mockResponse();
        await routeHandlers['get:/exchange-rates'](req, res);
        await Promise.resolve();

        expect(logger.warn).toHaveBeenCalledWith(
          'Background exchange rate refresh failed',
          expect.objectContaining({ error: 'refresh failed' })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('should handle exchange-rate query errors', async () => {
      mockDbQuery.mockRejectedValue(new Error('query failed'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/exchange-rates'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error retrieving exchange rates' });
    });
  });

  describe('POST /exchange-rates/refresh', () => {
    it('should clear cache and refresh exchange rates', async () => {
      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/exchange-rates/refresh'](req, res);

      expect(mockClearMemoryCache).toHaveBeenCalledTimes(1);
      expect(mockWarmCache).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({ message: 'Exchange rates refreshed from ECB' });
    });

    it('should handle exchange refresh errors', async () => {
      mockWarmCache.mockRejectedValueOnce(new Error('ecb down'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/exchange-rates/refresh'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error refreshing exchange rates' });
    });
  });

  describe('POST /refresh-views', () => {
    it('should refresh materialized views and return duration', async () => {
      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/refresh-views'](req, res);

      expect(mockRefreshMaterializedViews).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Materialized views refreshed', duration_ms: expect.any(Number) })
      );
    });

    it('should handle refresh-view failures', async () => {
      mockRefreshMaterializedViews.mockRejectedValueOnce(new Error('view refresh failed'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/refresh-views'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error refreshing materialized views' });
    });
  });

  describe('GET /portfolio-performance', () => {
    it('should return mapped snapshots with default date range', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        mockGetSnapshots.mockResolvedValue([
          {
            snapshot_date: '2026-04-10',
            invested: '1000.5',
            value: '1234.56',
            stocks_etfs_value: '500',
            crypto_value: '200',
            metals_value: '100',
            stocks_etfs_invested: '450',
            crypto_invested: '180',
            metals_invested: '90',
            inflation_adjusted_value: null,
            gain_loss: '234.06',
            return_pct: '23.4',
          },
        ]);

        const req = { query: { currency: 'USD' } };
        const res = mockResponse();
        await routeHandlers['get:/portfolio-performance'](req, res);

        expect(mockGetSnapshots).toHaveBeenCalledWith('2000-01-01', '2026-04-11', 'USD');
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            currency: 'USD',
            start_date: '2000-01-01',
            end_date: '2026-04-11',
            snapshots: [
              {
                date: '2026-04-10',
                invested: 1000.5,
                value: 1234.56,
                stocks_etfs_value: 500,
                crypto_value: 200,
                metals_value: 100,
                stocks_etfs_invested: 450,
                crypto_invested: 180,
                metals_invested: 90,
                inflation_adjusted_value: 1234.56,
                gain_loss: 234.06,
                return_pct: 23.4,
              },
            ],
          })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('should default invalid currency input to EUR', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        mockGetSnapshots.mockResolvedValue([]);

        const req = { query: { currency: 'invalid-currency' } };
        const res = mockResponse();
        await routeHandlers['get:/portfolio-performance'](req, res);

        expect(mockGetSnapshots).toHaveBeenCalledWith('2000-01-01', '2026-04-11', 'EUR');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should handle portfolio performance errors', async () => {
      mockGetSnapshots.mockRejectedValue(new Error('snapshots failed'));

      const req = { query: { start_date: '2026-01-01', end_date: '2026-01-31' } };
      const res = mockResponse();
      await routeHandlers['get:/portfolio-performance'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ detail: 'Error retrieving portfolio performance' });
    });
  });

  describe('warmInfoCaches', () => {
    it('should prewarm both caches and serve warmed values without extra repository calls', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        const netWorthPayload = {
          current: { liquid: 10, investments: 20, netWorth: 30 },
          snapshots: [{ date: '2026-04-10', netWorth: 30 }],
        };
        infoRepository.getNetWorthFromSnapshots.mockResolvedValue(netWorthPayload);
        mockGetSnapshots.mockResolvedValue([
          {
            snapshot_date: '2026-04-10',
            invested: '10',
            value: '12',
            stocks_etfs_value: '5',
            crypto_value: '4',
            metals_value: '3',
            stocks_etfs_invested: '4',
            crypto_invested: '3',
            metals_invested: '2',
            inflation_adjusted_value: '11',
            gain_loss: '2',
            return_pct: '20',
          },
        ]);

        await warmInfoCaches('JPY');

        const netWorthReq = { query: { currency: 'JPY' } };
        const netWorthRes = mockResponse();
        await routeHandlers['get:/net-worth'](netWorthReq, netWorthRes);

        const perfReq = { query: { currency: 'JPY' } };
        const perfRes = mockResponse();
        await routeHandlers['get:/portfolio-performance'](perfReq, perfRes);

        expect(infoRepository.getNetWorthFromSnapshots).toHaveBeenCalledTimes(1);
        expect(mockGetSnapshots).toHaveBeenCalledTimes(1);
        expect(netWorthRes.json).toHaveBeenCalledWith(netWorthPayload);
        expect(perfRes.json).toHaveBeenCalledWith(
          expect.objectContaining({ currency: 'JPY', start_date: '2000-01-01', end_date: '2026-04-11' })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('should continue warming portfolio cache when net-worth warm fails', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        infoRepository.getNetWorthFromSnapshots.mockRejectedValueOnce(new Error('net-worth warm failed'));
        mockGetSnapshots.mockResolvedValue([]);

        await warmInfoCaches('CAD');

        expect(logger.error).toHaveBeenCalledWith(
          'Failed to warm net-worth cache',
          expect.objectContaining({ error: 'net-worth warm failed' })
        );
        expect(mockGetSnapshots).toHaveBeenCalledWith('2000-01-01', '2026-04-11', 'CAD');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should log portfolio warm failures', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        infoRepository.getNetWorthFromSnapshots.mockResolvedValue({ current: {}, snapshots: [] });
        mockGetSnapshots.mockRejectedValueOnce(new Error('portfolio warm failed'));

        await warmInfoCaches('AUD');

        expect(logger.error).toHaveBeenCalledWith(
          'Failed to warm portfolio-performance cache',
          expect.objectContaining({ error: 'portfolio warm failed' })
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('GET /inflation-rates', () => {
    it('should return Belgian inflation rates', async () => {
      mockInflationService.getInflationRates.mockResolvedValue({
        source: 'database',
        rates: [
          { month: '2024-01', monthly_rate: 0.004 },
          { month: '2024-02', monthly_rate: 0.003 },
        ],
      });

      const req = { query: { start_month: '2024-01', end_month: '2024-12' } };
      const res = mockResponse();
      await routeHandlers['get:/inflation-rates'](req, res);

      expect(mockInflationService.getInflationRates).toHaveBeenCalledWith({
        startMonth: '2024-01',
        endMonth: '2024-12',
        dbOnly: false,
        scheduleBackgroundRefresh: false,
      });
      const payload = res.json.mock.calls[0][0];
      expect(payload.total_rates).toBe(2);
      expect(payload.source).toBe('database');
    });

    it('should ignore invalid month params', async () => {
      mockInflationService.getInflationRates.mockResolvedValue({ source: 'memory', rates: [] });

      const req = { query: { start_month: 'invalid', end_month: '2024/01' } };
      const res = mockResponse();
      await routeHandlers['get:/inflation-rates'](req, res);

      expect(mockInflationService.getInflationRates).toHaveBeenCalledWith({
        startMonth: undefined,
        endMonth: undefined,
        dbOnly: false,
        scheduleBackgroundRefresh: false,
      });
    });

    it('should pass db_only flag and enable background refresh scheduling', async () => {
      mockInflationService.getInflationRates.mockResolvedValue({
        source: 'database',
        rates: [{ month: '2024-01', monthly_rate: 0.004 }],
      });

      const req = { query: { db_only: 'true', start_month: '2024-01' } };
      const res = mockResponse();
      await routeHandlers['get:/inflation-rates'](req, res);

      expect(mockInflationService.getInflationRates).toHaveBeenCalledWith({
        startMonth: '2024-01',
        endMonth: undefined,
        dbOnly: true,
        scheduleBackgroundRefresh: true,
      });
    });

    it('should handle inflation route errors', async () => {
      mockInflationService.getInflationRates.mockRejectedValue(new Error('boom'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['get:/inflation-rates'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST /inflation-rates/refresh', () => {
    it('should refresh Belgian inflation rates', async () => {
      mockInflationService.getInflationRates.mockResolvedValue({ source: 'statbel', rates: [{ month: '2024-01', monthly_rate: 0.004 }] });

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/inflation-rates/refresh'](req, res);

      expect(mockInflationService.clearInflationMemoryCache).toHaveBeenCalled();
      expect(mockInflationService.getInflationRates).toHaveBeenCalledWith({ forceRefresh: true });
      const payload = res.json.mock.calls[0][0];
      expect(payload.total_rates).toBe(1);
      expect(payload.source).toBe('statbel');
    });

    it('should handle refresh errors', async () => {
      mockInflationService.getInflationRates.mockRejectedValue(new Error('refresh failed'));

      const req = { query: {} };
      const res = mockResponse();
      await routeHandlers['post:/inflation-rates/refresh'](req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});

function mockResponse() {
  const res = { json: vi.fn(), status: vi.fn(), send: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
