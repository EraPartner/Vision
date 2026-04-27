/**
 * Price Provider Service tests.
 * Tests price fetching from Binance, Yahoo, Kinesis, and custom endpoints.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockYahooQuote, mockYahooChart } = vi.hoisted(() => ({
  mockYahooQuote: vi.fn(),
  mockYahooChart: vi.fn(),
}));

vi.mock('yahoo-finance2', () => ({
  default: vi.fn().mockImplementation(function MockYahooFinance() {
    return {
      quote: mockYahooQuote,
      chart: mockYahooChart,
    };
  }),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import {
  fetchLivePrices,
  fetchLivePricesDetailed,
  fetchHistoricalPrices,
  sanitizePersistedKinesisHistory,
  getHistoricalPriceAt,
  SUPPORTED_PROVIDERS,
  __resetPriceCache,
} from '../src/services/priceProviderService.js';
import { query } from '../src/database/connection.js';

describe('Price Provider Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetPriceCache();
    mockYahooQuote.mockReset();
    mockYahooChart.mockReset();
    query.mockReset();
  });

  // ── SUPPORTED_PROVIDERS ────────────────────────────────────
  describe('SUPPORTED_PROVIDERS', () => {
    it('should list all supported providers', () => {
      expect(SUPPORTED_PROVIDERS.length).toBeGreaterThanOrEqual(4);
      const keys = SUPPORTED_PROVIDERS.map(p => p.key);
      expect(keys).toContain('manual');
      expect(keys).toContain('binance');
      expect(keys).toContain('yahoo');
      expect(keys).toContain('kinesis');
      expect(keys).toContain('custom');
    });

    it('should have name and description for each provider', () => {
      for (const provider of SUPPORTED_PROVIDERS) {
        expect(provider.name).toBeTruthy();
        expect(provider.description).toBeTruthy();
      }
    });
  });

  // ── fetchLivePrices ────────────────────────────────────────
  describe('fetchLivePrices', () => {
    it('should return empty object for empty list', async () => {
      const result = await fetchLivePrices([]);
      expect(result).toEqual({});
    });

    it('should skip manual provider investments', async () => {
      const result = await fetchLivePrices([
        { id: 1, price_provider: 'manual', price_provider_id: null },
      ]);
      expect(result).toEqual({});
    });

    it('should handle Binance API errors gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'binance', price_provider_id: 'BTCUSDT', currency: 'USD' },
      ]);

      // Should not throw, returns empty results for failed providers
      expect(typeof result).toBe('object');
    });

    it('should handle Yahoo Finance API errors gracefully', async () => {
      mockYahooQuote.mockRejectedValue(new Error('Network error'));

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'yahoo', price_provider_id: 'AAPL', currency: 'USD' },
      ]);

      expect(typeof result).toBe('object');
    });

    it('should handle Kinesis API errors gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'kinesis', price_provider_id: 'XAU_USD' },
      ]);

      expect(typeof result).toBe('object');
    });

    it('should handle custom provider with missing URL', async () => {
      const result = await fetchLivePrices([
        { id: 1, price_provider: 'custom', price_provider_id: 'price', price_provider_url: null },
      ]);

      expect(typeof result).toBe('object');
    });

    it('should group investments by provider', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          { symbol: 'BTCUSDT', price: '50000.00' },
          { symbol: 'ETHUSDT', price: '3000.00' },
        ]),
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'binance', price_provider_id: 'BTCUSDT', currency: 'USD' },
        { id: 2, price_provider: 'binance', price_provider_id: 'ETHUSDT', currency: 'USD' },
      ]);

      // Should batch into single Binance call
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(result[1]).toBe(50000);
      expect(result[2]).toBe(3000);
    });

    it('should handle Binance successful response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ symbol: 'BTCUSDT', price: '50000.00' }]),
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'binance', price_provider_id: 'BTCUSDT', currency: 'USD' },
      ]);

      expect(result[1]).toBe(50000);
    });

    it('should handle Kinesis successful response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          XAU_USD: [
            { createdAt: '2026-01-01T00:00:00Z', price: 1987.12 },
            { createdAt: '2026-01-02T00:00:00Z', price: 1999.99 },
          ],
        }),
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'kinesis', price_provider_id: 'XAU_USD' },
      ]);

      expect(result[1]).toBe(1999.99);
    });

    it('should resolve Kinesis symbol from configured asset name when provider id is missing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          KAU_USD: [
            { createdAt: '2026-01-01T00:00:00Z', price: 101.5 },
            { createdAt: '2026-01-02T00:00:00Z', price: 102.25 },
          ],
        }),
      });

      const result = await fetchLivePrices([
        { id: 1, name: 'kaufen_gold', price_provider: 'kinesis', price_provider_id: null, currency: 'USD' },
      ]);

      expect(result[1]).toBe(102.25);
    });

    it('should handle Yahoo Finance successful response', async () => {
      mockYahooQuote.mockResolvedValue({
        symbol: 'AAPL',
        regularMarketPrice: 175.50,
        regularMarketPreviousClose: 174.20,
        currency: 'USD',
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'yahoo', price_provider_id: 'AAPL', currency: 'USD' },
      ]);

      expect(result[1]).toBe(175.50);
    });

    it('should fallback to previous close for Yahoo when live is zero', async () => {
      mockYahooQuote.mockResolvedValue({
        symbol: 'AAPL',
        regularMarketPrice: 0,
        regularMarketPreviousClose: 174.20,
        currency: 'USD',
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'yahoo', price_provider_id: 'AAPL', currency: 'USD' },
      ]);

      expect(result[1]).toBe(174.20);
    });

    it('should fallback to cached DB price when provider has no valid quote', async () => {
      mockYahooQuote.mockResolvedValue({
        symbol: 'AAPL',
        regularMarketPrice: 0,
        regularMarketPreviousClose: 0,
        currency: 'USD',
      });

      const result = await fetchLivePricesDetailed(
        [{ id: 1, price_provider: 'yahoo', price_provider_id: 'AAPL', currency: 'USD' }],
        { cachedPricesByInvestmentId: { 1: 171.11 } }
      );

      expect(result[1]).toEqual({ price: 171.11, source: 'cached' });
    });

    it('should fallback to Yahoo chart close when quote endpoints return zero', async () => {
      mockYahooQuote.mockResolvedValue({
        symbol: 'AAPL',
        regularMarketPrice: 0,
        regularMarketPreviousClose: 0,
        currency: 'USD',
      });
      mockYahooChart.mockResolvedValue({
        quotes: [{ close: undefined }, { close: 173.22 }],
      });

      const result = await fetchLivePricesDetailed([
        { id: 1, price_provider: 'yahoo', price_provider_id: 'AAPL', currency: 'USD' },
      ]);

      expect(result[1]).toEqual({ price: 173.22, source: 'close' });
    });

    it('should use yahoo-finance2 quote path for Yahoo provider', async () => {
      mockYahooQuote.mockResolvedValue({
        symbol: 'IONQ',
        regularMarketPrice: 31.2,
        regularMarketPreviousClose: 31.9,
        currency: 'USD',
      });

      const result = await fetchLivePricesDetailed([
        { id: 1, price_provider: 'yahoo', price_provider_id: 'IONQ', currency: 'USD' },
      ]);

      expect(result[1]).toEqual({ price: 31.2, source: 'live' });
    });

    it('should use yahoo-finance2 previous close when live is unavailable', async () => {
      mockYahooQuote.mockResolvedValue({
        symbol: 'IONQ',
        regularMarketPrice: 0,
        regularMarketPreviousClose: 31.9,
        currency: 'USD',
      });

      const result = await fetchLivePricesDetailed([
        { id: 1, price_provider: 'yahoo', price_provider_id: 'IONQ', currency: 'USD' },
      ]);

      expect(result[1]).toEqual({ price: 31.9, source: 'close' });
    });

    it('should resolve Yahoo symbol from investment.symbol when provider id is missing', async () => {
      mockYahooQuote.mockResolvedValue({
        symbol: 'MSFT',
        regularMarketPrice: 420.15,
        regularMarketPreviousClose: 418.9,
        currency: 'USD',
      });

      const result = await fetchLivePricesDetailed([
        { id: 1, price_provider: 'yahoo', price_provider_id: null, symbol: 'msft', currency: 'USD' },
      ]);

      expect(result[1]).toEqual({ price: 420.15, source: 'live' });
    });

    it('should handle custom JSON endpoint', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { price: 42.50 } }),
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'custom', price_provider_id: 'data.price', price_provider_url: 'https://example.com/price' },
      ]);

      expect(result[1]).toBe(42.50);
    });

    it('should derive custom latest from history payload when latest path is missing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          points: [
            { timestamp_ms: 1700000000000, price: 700 },
            { timestamp_ms: 1700000100000, price: 710 },
          ],
        }),
      });

      const result = await fetchLivePrices([
        {
          id: 1,
          price_provider: 'custom',
          price_provider_latest_url: 'https://example.com/napoleon',
          price_provider_history_path: 'points',
          price_provider_history_ts_path: 'timestamp_ms',
          price_provider_history_price_path: 'price',
        },
      ]);

      expect(result[1]).toBe(710);
    });

    it('should fetch latest from history endpoint when latest endpoint is unavailable', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            points: [
              { timestamp_ms: 1700000000000, price: 705.1 },
              { timestamp_ms: 1700000100000, price: 706.8 },
            ],
          }),
        });

      const result = await fetchLivePrices([
        {
          id: 1,
          price_provider: 'custom',
          price_provider_latest_url: 'https://example.com/latest',
          price_provider_latest_path: 'napoleon.price',
          price_provider_history_url: 'https://example.com/history',
          price_provider_history_path: 'points',
          price_provider_history_ts_path: 'timestamp_ms',
          price_provider_history_price_path: 'price',
        },
      ]);

      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(result[1]).toBe(706.8);
    });

    it('should handle custom provider HTTP error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'custom', price_provider_id: 'price', price_provider_url: 'https://example.com/price' },
      ]);

      expect(result[1]).toBeUndefined();
    });

    it('should re-use provider cache and apply cached-price fallback map', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ symbol: 'BTCUSDT', price: '50000.00' }]),
      });

      const inv = { id: 1, price_provider: 'binance', price_provider_id: 'BTCUSDT', currency: 'USD' };
      const first = await fetchLivePricesDetailed([inv]);
      const second = await fetchLivePricesDetailed([inv]);

      expect(first[1]).toEqual({ price: 50000, source: 'live' });
      expect(second[1]).toEqual({ price: 50000, source: 'live' });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      const fallbackResult = await fetchLivePricesDetailed(
        [{ id: 9, price_provider: 'custom', price_provider_url: 'https://bad.example' }],
        { cachedPricesByInvestmentId: { 9: 123.45 } }
      );
      expect(fallbackResult[9]).toEqual({ price: 123.45, source: 'cached' });
    });

    it('should handle mixed providers', async () => {
      // Will fail all fetches but should not throw
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network'));

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'binance', price_provider_id: 'BTCUSDT', currency: 'USD' },
        { id: 2, price_provider: 'yahoo', price_provider_id: 'AAPL', currency: 'USD' },
        { id: 3, price_provider: 'manual', price_provider_id: null },
      ]);

      expect(typeof result).toBe('object');
      // Manual should be skipped, others failed gracefully
    });
  });

  describe('fetchHistoricalPrices', () => {
    it('returns covered range from database cache without provider fetch', async () => {
      const fromMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
      const toMs = Date.UTC(2026, 0, 10, 23, 59, 59, 999);

      query.mockResolvedValue({
        rows: [
          { price_date: '2026-01-01', close_price: '100' },
          { price_date: '2026-01-10', close_price: '120' },
        ],
      });

      const points = await fetchHistoricalPrices(
        {
          id: 11,
          price_provider: 'yahoo',
          price_provider_id: 'AAPL',
        },
        { fromMs, toMs }
      );

      expect(points).toEqual([
        { timestampMs: Date.UTC(2026, 0, 1, 12, 0, 0, 0), price: 100 },
        { timestampMs: Date.UTC(2026, 0, 10, 12, 0, 0, 0), price: 120 },
      ]);
      expect(mockYahooChart).not.toHaveBeenCalled();
    });

    it('sanitizes covered cached DB points for kinesis without provider refetch', async () => {
      const fromMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
      const toMs = Date.UTC(2026, 0, 5, 23, 59, 59, 999);

      query
        .mockResolvedValueOnce({
          rows: [
            { price_date: '2026-01-01', close_price: '100' },
            { price_date: '2026-01-02', close_price: '101' },
            { price_date: '2026-01-03', close_price: '1200' },
            { price_date: '2026-01-04', close_price: '102' },
            { price_date: '2026-01-05', close_price: '103' },
          ],
        })
        .mockResolvedValueOnce({});

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const points = await fetchHistoricalPrices(
        {
          id: 24,
          price_provider: 'kinesis',
          price_provider_id: 'XAU_USD',
        },
        { fromMs, toMs }
      );

      expect(points).toHaveLength(5);
      expect(points[2]?.price).toBeGreaterThan(100);
      expect(points[2]?.price).toBeLessThan(103);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('returns normalized custom history points with filters', async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({
          rows: [
            { price_date: '2023-11-14', close_price: '710' },
          ],
        });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: {
            series: [
              { ts: 1700000000000, px: 700 },
              { ts: 1700000100000, px: 710 },
              { ts: 1700000200000, px: 720 },
            ],
          },
        }),
      });

      const points = await fetchHistoricalPrices(
        {
          id: 5,
          price_provider: 'custom',
          price_provider_history_url: 'https://example.com/series',
          price_provider_history_path: 'data.series',
          price_provider_history_ts_path: 'ts',
          price_provider_history_price_path: 'px',
        },
        {
          fromMs: Date.UTC(2023, 10, 14, 0, 0, 0, 0),
          toMs: Date.UTC(2023, 10, 14, 23, 59, 59, 999),
        }
      );

      expect(points).toEqual([
        { timestampMs: Date.UTC(2023, 10, 14, 12, 0, 0, 0), price: 710 },
      ]);
    });

    it('falls back to cached database points when provider fetch fails', async () => {
      const fromMs = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
      const toMs = Date.UTC(2026, 0, 20, 23, 59, 59, 999);

      query.mockResolvedValue({
        rows: [
          { price_date: '2026-01-03', close_price: '104.5' },
        ],
      });

      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

      const points = await fetchHistoricalPrices(
        {
          id: 12,
          price_provider: 'custom',
          price_provider_history_url: 'https://example.com/history',
          price_provider_history_path: 'points',
          price_provider_history_ts_path: 'timestamp_ms',
          price_provider_history_price_path: 'price',
        },
        { fromMs, toMs }
      );

      expect(points).toEqual([
        { timestampMs: Date.UTC(2026, 0, 3, 12, 0, 0, 0), price: 104.5 },
      ]);
    });

    it('sanitizes isolated Kinesis spike while preserving surrounding points', async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          XAU_USD: [
            { createdAt: '2026-01-01T00:00:00Z', price: 100 },
            { createdAt: '2026-01-02T00:00:00Z', price: 101 },
            { createdAt: '2026-01-03T00:00:00Z', price: 1200 },
            { createdAt: '2026-01-04T00:00:00Z', price: 102 },
            { createdAt: '2026-01-05T00:00:00Z', price: 103 },
          ],
        }),
      });

      const points = await fetchHistoricalPrices(
        {
          id: 22,
          price_provider: 'kinesis',
          price_provider_id: 'XAU_USD',
        },
        {
          fromMs: Date.UTC(2026, 0, 1, 0, 0, 0, 0),
          toMs: Date.UTC(2026, 0, 5, 23, 59, 59, 999),
        }
      );

      expect(points).toHaveLength(5);
      // The isolated needle on 2026-01-03 should be replaced near neighbors, not kept as 1200.
      expect(points[2]?.price).toBeGreaterThan(100);
      expect(points[2]?.price).toBeLessThan(103);
      expect(points[0]?.price).toBe(100);
      expect(points[1]?.price).toBe(101);
      expect(points[3]?.price).toBe(102);
      expect(points[4]?.price).toBe(103);
    });

    it('sanitizes moderate one-day Kinesis spike and preserves series detail', async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [] });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          KAU_USD: [
            { createdAt: '2023-05-19T00:00:00Z', price: 59 },
            { createdAt: '2023-05-20T00:00:00Z', price: 60 },
            { createdAt: '2023-05-21T00:00:00Z', price: 120 },
            { createdAt: '2023-05-22T00:00:00Z', price: 61 },
            { createdAt: '2023-05-23T00:00:00Z', price: 62 },
          ],
        }),
      });

      const points = await fetchHistoricalPrices(
        {
          id: 23,
          price_provider: 'kinesis',
          price_provider_id: 'KAU_EUR',
        },
        {
          fromMs: Date.UTC(2023, 4, 19, 0, 0, 0, 0),
          toMs: Date.UTC(2023, 4, 23, 23, 59, 59, 999),
        }
      );

      expect(points).toHaveLength(5);
      expect(points[0]?.price).toBe(59);
      expect(points[1]?.price).toBe(60);
      expect(points[2]?.price).toBeGreaterThan(60);
      expect(points[2]?.price).toBeLessThan(61.5);
      expect(points[3]?.price).toBe(61);
      expect(points[4]?.price).toBe(62);
    });

    it('returns empty history for yahoo when symbol cannot be resolved', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const points = await fetchHistoricalPrices({ id: 1, price_provider: 'yahoo', price_provider_id: '', symbol: '' }, {});
      expect(points).toEqual([]);
    });

    it('fetches and persists binance history points', async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ price_date: '2026-01-01', close_price: '100' }] });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([
          [Date.UTC(2026, 0, 1), '0', '0', '0', '100', '0'],
        ]),
      });

      const points = await fetchHistoricalPrices({ id: 11, price_provider: 'binance', price_provider_id: 'BTCUSDT' }, {});

      expect(points).toHaveLength(1);
      expect(points[0].price).toBe(100);
    });

    it('falls back to cached db points when kinesis has no symbol', async () => {
      query.mockResolvedValueOnce({ rows: [{ price_date: '2026-01-03', close_price: '104.5' }] });

      const points = await fetchHistoricalPrices(
        { id: 12, price_provider: 'kinesis', price_provider_id: '', name: 'unknown-asset' },
        {}
      );

      expect(points).toEqual([
        { timestampMs: Date.UTC(2026, 0, 3, 12, 0, 0, 0), price: 104.5 },
      ]);
    });

    it('returns db-only custom history when dbOnly mode is enabled', async () => {
      query.mockResolvedValueOnce({
        rows: [
          { price_date: '2026-01-01', close_price: '99' },
          { price_date: '2026-01-02', close_price: '101' },
        ],
      });

      const points = await fetchHistoricalPrices(
        {
          id: 13,
          price_provider: 'custom',
          price_provider_history_url: 'https://example.com/history',
          price_provider_history_path: 'points',
          price_provider_history_ts_path: 'timestamp_ms',
          price_provider_history_price_path: 'price',
        },
        { dbOnly: true }
      );

      expect(points).toHaveLength(2);
      expect(points[0].price).toBe(99);
    });

    it('returns db fallback for unsupported providers', async () => {
      query.mockResolvedValueOnce({ rows: [{ price_date: '2026-01-04', close_price: '88' }] });

      const points = await fetchHistoricalPrices({ id: 14, price_provider: 'manual' }, {});

      expect(points).toEqual([
        { timestampMs: Date.UTC(2026, 0, 4, 12, 0, 0, 0), price: 88 },
      ]);
    });
  });

  describe('sanitizePersistedKinesisHistory', () => {
    it('returns zero summary when there are no kinesis investments', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const result = await sanitizePersistedKinesisHistory();

      expect(result).toEqual({ processed: 0, updated: 0, correctedPoints: 0, failed: 0 });
    });

    it('sanitizes persisted kinesis spikes and saves corrected points', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ id: 42 }] })
        .mockResolvedValueOnce({
          rows: [
            { price_date: '2026-01-01', close_price: '100' },
            { price_date: '2026-01-02', close_price: '101' },
            { price_date: '2026-01-03', close_price: '1200' },
            { price_date: '2026-01-04', close_price: '102' },
            { price_date: '2026-01-05', close_price: '103' },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });

      const result = await sanitizePersistedKinesisHistory();

      expect(result).toEqual({ processed: 1, updated: 1, correctedPoints: 1, failed: 0 });
      expect(query).toHaveBeenCalledTimes(3);
    });

    it('increments failed count when loading persisted points throws', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ id: 42 }] })
        .mockRejectedValueOnce(new Error('history load failed'));

      const result = await sanitizePersistedKinesisHistory();

      expect(result).toEqual({ processed: 1, updated: 0, correctedPoints: 0, failed: 1 });
    });
  });

  describe('getHistoricalPriceAt', () => {
    it('returns the last point at or before requested timestamp', () => {
      const points = [
        { timestampMs: 1000, price: 10 },
        { timestampMs: 2000, price: 20 },
        { timestampMs: 3000, price: 30 },
      ];

      expect(getHistoricalPriceAt(points, 2500)).toBe(20);
      expect(getHistoricalPriceAt(points, 3000)).toBe(30);
      expect(getHistoricalPriceAt(points, 999)).toBeUndefined();
    });
  });
});
