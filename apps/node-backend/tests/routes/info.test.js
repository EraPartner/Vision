/**
 * Info/Statistics route tests.
 * Mirrors: apps/backend/tests/test_info.py
 *
 * Runs against the REAL router mounted on a throwaway Express app (see
 * tests/helpers/routeApp.js). `info.js` is a barrel over six sub-routers
 * (statistics/netWorth/rates/performance/portfolioSummary/maintenance); the
 * old mock-router harness flattened all of them into one handler map by
 * aliasing every nested `Router()` call to the same stub — which also meant
 * every per-route guard (`rateLimiter`/`adminRateLimiter` declared INSIDE
 * netWorth.js, rates.js, performance.js, portfolioSummary.js) was silently
 * dropped. Those limiters are real now; this suite's request counts per
 * keyPrefix stay far under every limit (30-500/60s) so nothing 429s.
 *
 * Mount path is /api/info — no app-level per-mount middleware (main.js:322).
 *
 * Several handlers here cascade into real (unmocked) services —
 * getPortfolioSummary, resolveLivePortfolioValue, settingsRepository,
 * portfolioTransactionRepository, the adapter registry — exactly as they did
 * under the old harness (only Express itself was mocked there, never these
 * imports). `database/connection.js`'s `query` is mocked to `{rows: []}` by
 * default so that cascade resolves to an empty-but-valid summary instead of
 * hitting a real DB.
 *
 * Dropped: "should register /refresh-views and /inflation-rates/refresh
 * routes" — that was a structural check against the mock router's handler
 * map (`routeHandlers['post:/refresh-views']` etc. being a function), which
 * has no equivalent against a real router and is redundant with the
 * dedicated POST /refresh-views and POST /inflation-rates/refresh tests
 * below, which already prove the routes exist and work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { routeAgent, okEnvelope, errEnvelope } from '../helpers/routeApp.js';

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
  logger: mockLogger(),
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
const mockListLatestStoredRates = vi.fn();
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

vi.mock('../../src/services/currency/currencyConversionService.js', () => ({
  FALLBACK_RATES: { USD: 1.1 },
  warmCache: mockWarmCache,
  clearMemoryCache: mockClearMemoryCache,
  listLatestStoredRates: mockListLatestStoredRates,
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
const { default: infoRouter } = await import('../../src/routes/info.js');
const { warmInfoCaches } = await import('../../src/routes/info.js');

const BASE = '/api/info';
const api = routeAgent(infoRouter, { mountPath: BASE });

describe('Info Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWarmCache.mockResolvedValue(undefined);
    mockRefreshMaterializedViews.mockResolvedValue(undefined);
    mockDetectRecurringPatterns.mockResolvedValue({ patterns: [], total: 0 });
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockListLatestStoredRates.mockResolvedValue({ rows: [] });
    mockGetSnapshots.mockResolvedValue([]);
  });

  describe('GET /supported-adapters', () => {
    it('serves the registry-derived adapter list (no hardcoded drift)', async () => {
      const res = await api.get(`${BASE}/supported-adapters`).expect(200);
      const { data } = res.body;

      // Registry-derived: one entry per non-generic adapter, keyed by name with
      // the adapter's bankName label. Adding an adapter exposes it automatically.
      const keys = data.items.map((a) => a.key);
      expect(keys).toContain('bnp');
      expect(keys).toContain('wise');
      expect(keys).not.toContain('generic');
      expect(data.total).toBe(data.items.length);
      // bankName label, not a hardcoded display string / nonexistent class name.
      const bnp = data.items.find((a) => a.key === 'bnp');
      expect(bnp.name).toBe('BNP Paribas Fortis');
      expect(bnp.adapter_class).toBeUndefined();
    });

    it('should return supported adapters', async () => {
      const res = await api.get(`${BASE}/supported-adapters`).expect(200);

      const result = res.body.data;
      expect(result.items).toBeDefined();
      expect(result.total).toBeGreaterThan(0);
    });
  });

  describe('GET /banks', () => {
    it('should return bank list', async () => {
      infoRepository.getBanks.mockResolvedValue(['Chase', 'Revolut']);

      const res = await api.get(`${BASE}/banks`).expect(200);

      expect(res.body.data.items).toHaveLength(2);
    });

    it('should return empty for no banks', async () => {
      infoRepository.getBanks.mockResolvedValue([]);

      const res = await api.get(`${BASE}/banks`).expect(200);

      expect(res.body.data).toEqual({ items: [], total: 0 });
    });

    it('should handle database errors', async () => {
      infoRepository.getBanks.mockRejectedValue(new Error('DB error'));

      const res = await api.get(`${BASE}/banks`).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });

  describe('GET /transaction-count', () => {
    it('should return count', async () => {
      infoRepository.getTransactionCount.mockResolvedValue(42);

      const res = await api.get(`${BASE}/transaction-count`).expect(200);

      expect(res.body.data.total_transactions).toBe(42);
    });

    it('should return 0 for empty', async () => {
      infoRepository.getTransactionCount.mockResolvedValue(0);

      const res = await api.get(`${BASE}/transaction-count`).expect(200);

      expect(res.body.data.total_transactions).toBe(0);
    });

    it('should handle errors', async () => {
      infoRepository.getTransactionCount.mockRejectedValue(new Error('DB error'));

      const res = await api.get(`${BASE}/transaction-count`).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
    });
  });

  describe('GET /planned-expenses-next-month', () => {
    it('should return planned expenses', async () => {
      infoRepository.getPlannedExpensesNextMonth.mockResolvedValue({ total: 500 });

      const res = await api.get(`${BASE}/planned-expenses-next-month`).expect(200);
      expect(res.body.ok).toBe(true);
    });

    it('should handle errors', async () => {
      infoRepository.getPlannedExpensesNextMonth.mockRejectedValue(new Error('DB error'));

      const res = await api.get(`${BASE}/planned-expenses-next-month`).expect(500);
      expect(res.body).toEqual(errEnvelope({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' }));
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

      const res = await api.get(`${BASE}/net-worth`).query({ currency: 'EUR' }).expect(200);

      const result = res.body.data;
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

      const res = await api.get(`${BASE}/net-worth`).query({ currency: 'USD' }).expect(200);

      const result = res.body.data;
      expect(result.current.netWorth).toBe(0);
      expect(result.snapshots).toHaveLength(0);
    });

    it('should handle errors', async () => {
      infoRepository.getNetWorthFromSnapshots.mockRejectedValue(new Error('DB error'));

      const res = await api.get(`${BASE}/net-worth`).query({ currency: 'GBP' }).expect(500);
      expect(res.body).toEqual(errEnvelope({ message: expect.any(String) }));
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

      const res = await api.get(`${BASE}/net-worth`).query({ currency: 'AUD', limit: '2', offset: '0' }).expect(200);

      const result = res.body.data;
      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots[0].date).toBe('2026-03-05');
      expect(result.snapshots[1].date).toBe('2026-03-04');
      expect(result.snapshotsTotal).toBe(5);
      // Pagination facts live in the body, not in envelope meta — the
      // meta.pagination convention is retired (packages/types/src/api.js).
      expect(result.snapshotsLimit).toBe(2);
      expect(result.snapshotsOffset).toBe(0);
      expect(res.body.meta.requestId).toEqual(expect.any(String));
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

      const res = await api.get(`${BASE}/net-worth`).query({ currency: 'CAD', limit: '2', offset: '2' }).expect(200);

      const result = res.body.data;
      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots[0].date).toBe('2026-03-02');
      expect(result.snapshots[1].date).toBe('2026-03-01');
      expect(result.snapshotsTotal).toBe(4);
      expect(result.snapshotsOffset).toBe(2);
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

      const res = await api.get(`${BASE}/net-worth`).query({ currency: 'CHF' }).expect(200);

      const result = res.body.data;
      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots[0].date).toBe('2026-03-01');
      // Unpaginated: no pagination fields at all — the body IS the whole series.
      expect(result.snapshotsTotal).toBeUndefined();
      expect(result.snapshotsLimit).toBeUndefined();
      expect(result.snapshotsOffset).toBeUndefined();
    });
  });

  describe('GET /recurring-patterns', () => {
    it('should return recurring patterns payload', async () => {
      mockDetectRecurringPatterns.mockResolvedValue({
        patterns: [{ recipient: 'Netflix', interval_days: 30 }],
        total: 1,
      });

      const res = await api.get(`${BASE}/recurring-patterns`).expect(200);

      expect(res.body).toEqual(okEnvelope({ patterns: [{ recipient: 'Netflix', interval_days: 30 }], total: 1 }));
    });

    it('should return empty recurring payload when detector fails', async () => {
      mockDetectRecurringPatterns.mockRejectedValue(new Error('detector failed'));

      const res = await api.get(`${BASE}/recurring-patterns`).expect(200);

      expect(logger.error).toHaveBeenCalledWith(
        'Error detecting recurring patterns; returning empty result',
        expect.objectContaining({ error: 'detector failed' })
      );
      expect(res.body).toEqual(okEnvelope({ patterns: [], total: 0 }));
    });
  });

  describe('GET /exchange-rates', () => {
    it('should return mapped rates and trigger background refresh when stale', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        mockListLatestStoredRates.mockResolvedValue({
          rows: [
            {
              currency_code: 'USD',
              rate_to_eur: '1.2345',
              rate_date: '2026-04-10',
              fetched_at: '2026-04-10T08:30:00.000Z',
            },
          ],
        });

        const res = await api.get(`${BASE}/exchange-rates`).expect(200);

        expect(mockClearMemoryCache).toHaveBeenCalledTimes(1);
        expect(mockWarmCache).toHaveBeenCalledTimes(1);
        expect(res.body).toEqual(okEnvelope({
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
          source: 'database',
          is_stale: true,
          last_fetched_at: '2026-04-10T08:30:00.000Z',
        }));
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not trigger background refresh when rates are current', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        mockListLatestStoredRates.mockResolvedValue({
          rows: [
            {
              currency_code: 'GBP',
              rate_to_eur: '0.89',
              rate_date: new Date('2026-04-11T00:00:00.000Z'),
              fetched_at: '2026-04-11T01:00:00.000Z',
            },
          ],
        });

        const res = await api.get(`${BASE}/exchange-rates`).expect(200);

        expect(mockClearMemoryCache).not.toHaveBeenCalled();
        expect(mockWarmCache).not.toHaveBeenCalled();
        expect(res.body).toEqual(okEnvelope(expect.objectContaining({
          total_rates: 1,
          rates: [expect.objectContaining({ currency: 'GBP', rate_date: '2026-04-11' })],
        })));
      } finally {
        vi.useRealTimers();
      }
    });

    it('should log warning when background refresh fails', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        mockListLatestStoredRates.mockResolvedValue({
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

        await api.get(`${BASE}/exchange-rates`).expect(200);
        await Promise.resolve();
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
      mockListLatestStoredRates.mockRejectedValue(new Error('query failed'));

      const res = await api.get(`${BASE}/exchange-rates`).expect(500);
      expect(res.body).toEqual(errEnvelope({ message: expect.any(String) }));
    });
  });

  describe('POST /exchange-rates/refresh', () => {
    it('should clear cache and refresh exchange rates', async () => {
      const res = await api.post(`${BASE}/exchange-rates/refresh`).send({}).expect(200);

      expect(mockClearMemoryCache).toHaveBeenCalledTimes(1);
      expect(mockWarmCache).toHaveBeenCalledTimes(1);
      expect(res.body).toEqual(okEnvelope({ message: 'Exchange rates refreshed from ECB' }));
    });

    it('should handle exchange refresh errors', async () => {
      mockWarmCache.mockRejectedValueOnce(new Error('ecb down'));

      const res = await api.post(`${BASE}/exchange-rates/refresh`).send({}).expect(500);
      expect(res.body).toEqual(errEnvelope({ message: expect.any(String) }));
    });
  });

  describe('POST /refresh-views', () => {
    it('should refresh materialized views and return duration', async () => {
      const res = await api.post(`${BASE}/refresh-views`).send({}).expect(200);

      expect(mockRefreshMaterializedViews).toHaveBeenCalledTimes(1);
      expect(res.body).toEqual(okEnvelope(expect.objectContaining({
        message: 'Materialized views refreshed', duration_ms: expect.any(Number),
      })));
    });

    it('should handle refresh-view failures', async () => {
      mockRefreshMaterializedViews.mockRejectedValueOnce(new Error('view refresh failed'));

      const res = await api.post(`${BASE}/refresh-views`).send({}).expect(500);
      expect(res.body).toEqual(errEnvelope({ message: expect.any(String) }));
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

        const res = await api.get(`${BASE}/portfolio-performance`).query({ currency: 'USD' }).expect(200);

        expect(mockGetSnapshots).toHaveBeenCalledWith('2000-01-01', '2026-04-11', 'USD');
        expect(res.body).toEqual(okEnvelope(expect.objectContaining({
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
              // The response boundary deliberately derives this from value and
              // invested instead of trusting a stale stored percentage.
              return_pct: (234.06 / 1000.5) * 100,
            },
          ],
        })));
      } finally {
        vi.useRealTimers();
      }
    });

    it('should default invalid currency input to EUR', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-11T10:00:00.000Z'));
        mockGetSnapshots.mockResolvedValue([]);

        await api.get(`${BASE}/portfolio-performance`).query({ currency: 'invalid-currency' }).expect(200);

        expect(mockGetSnapshots).toHaveBeenCalledWith('2000-01-01', '2026-04-11', 'EUR');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should handle portfolio performance errors', async () => {
      mockGetSnapshots.mockRejectedValue(new Error('snapshots failed'));

      const res = await api.get(`${BASE}/portfolio-performance`)
        .query({ start_date: '2026-01-01', end_date: '2026-01-31' })
        .expect(500);
      expect(res.body).toEqual(errEnvelope({ message: expect.any(String) }));
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

        const netWorthRes = await api.get(`${BASE}/net-worth`).query({ currency: 'JPY' }).expect(200);
        const perfRes = await api.get(`${BASE}/portfolio-performance`).query({ currency: 'JPY' }).expect(200);

        expect(infoRepository.getNetWorthFromSnapshots).toHaveBeenCalledTimes(1);
        expect(mockGetSnapshots).toHaveBeenCalledTimes(1);
        expect(netWorthRes.body).toEqual(okEnvelope(netWorthPayload));
        expect(perfRes.body).toEqual(okEnvelope(expect.objectContaining({
          currency: 'JPY', start_date: '2000-01-01', end_date: '2026-04-11',
        })));
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

      const res = await api.get(`${BASE}/inflation-rates`).query({ start_month: '2024-01', end_month: '2024-12' }).expect(200);

      expect(mockInflationService.getInflationRates).toHaveBeenCalledWith({
        startMonth: '2024-01',
        endMonth: '2024-12',
        dbOnly: true,
        scheduleBackgroundRefresh: true,
      });
      const payload = res.body.data;
      expect(payload.total_rates).toBe(2);
      expect(payload.source).toBe('database');
    });

    it('should ignore invalid month params', async () => {
      mockInflationService.getInflationRates.mockResolvedValue({ source: 'memory', rates: [] });

      await api.get(`${BASE}/inflation-rates`).query({ start_month: 'invalid', end_month: '2024/01' }).expect(200);

      expect(mockInflationService.getInflationRates).toHaveBeenCalledWith({
        startMonth: undefined,
        endMonth: undefined,
        dbOnly: true,
        scheduleBackgroundRefresh: true,
      });
    });

    it('should pass db_only flag and enable background refresh scheduling', async () => {
      mockInflationService.getInflationRates.mockResolvedValue({
        source: 'database',
        rates: [{ month: '2024-01', monthly_rate: 0.004 }],
      });

      await api.get(`${BASE}/inflation-rates`).query({ db_only: 'true', start_month: '2024-01' }).expect(200);

      expect(mockInflationService.getInflationRates).toHaveBeenCalledWith({
        startMonth: '2024-01',
        endMonth: undefined,
        dbOnly: true,
        scheduleBackgroundRefresh: true,
      });
    });

    it('should opt out of db-only when db_only=false (synchronous live fetch)', async () => {
      mockInflationService.getInflationRates.mockResolvedValue({
        source: 'statbel',
        rates: [{ month: '2024-01', monthly_rate: 0.004 }],
      });

      await api.get(`${BASE}/inflation-rates`).query({ db_only: 'false' }).expect(200);

      expect(mockInflationService.getInflationRates).toHaveBeenCalledWith({
        startMonth: undefined,
        endMonth: undefined,
        dbOnly: false,
        scheduleBackgroundRefresh: false,
      });
    });

    it('should handle inflation route errors', async () => {
      mockInflationService.getInflationRates.mockRejectedValue(new Error('boom'));

      const res = await api.get(`${BASE}/inflation-rates`).expect(500);
      expect(res.body).toEqual(errEnvelope({ message: expect.any(String) }));
    });
  });

  describe('POST /inflation-rates/refresh', () => {
    it('should refresh Belgian inflation rates', async () => {
      mockInflationService.getInflationRates.mockResolvedValue({ source: 'statbel', rates: [{ month: '2024-01', monthly_rate: 0.004 }] });

      const res = await api.post(`${BASE}/inflation-rates/refresh`).send({}).expect(200);

      expect(mockInflationService.clearInflationMemoryCache).toHaveBeenCalled();
      expect(mockInflationService.getInflationRates).toHaveBeenCalledWith({ forceRefresh: true });
      const payload = res.body.data;
      expect(payload.total_rates).toBe(1);
      expect(payload.source).toBe('statbel');
    });

    it('should handle refresh errors', async () => {
      mockInflationService.getInflationRates.mockRejectedValue(new Error('refresh failed'));

      const res = await api.post(`${BASE}/inflation-rates/refresh`).send({}).expect(500);
      expect(res.body).toEqual(errEnvelope({ message: expect.any(String) }));
    });
  });
});
