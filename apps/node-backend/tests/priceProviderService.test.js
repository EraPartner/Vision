/**
 * Price Provider Service tests.
 * Tests price fetching from CoinGecko, Yahoo, Kraken, and custom endpoints.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockYahooQuote, mockYahooChart } = vi.hoisted(() => ({
  mockYahooQuote: vi.fn(),
  mockYahooChart: vi.fn(),
}));

vi.mock('yahoo-finance2', () => ({
  default: vi.fn().mockImplementation(() => ({
    quote: mockYahooQuote,
    chart: mockYahooChart,
  })),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  fetchLivePrices,
  fetchLivePricesDetailed,
  fetchHistoricalPrices,
  getHistoricalPriceAt,
  SUPPORTED_PROVIDERS,
  __resetPriceCache,
} from '../src/services/priceProviderService.js';

describe('Price Provider Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    __resetPriceCache();
    mockYahooQuote.mockReset();
    mockYahooChart.mockReset();
  });

  // ── SUPPORTED_PROVIDERS ────────────────────────────────────
  describe('SUPPORTED_PROVIDERS', () => {
    it('should list all supported providers', () => {
      expect(SUPPORTED_PROVIDERS.length).toBeGreaterThanOrEqual(4);
      const keys = SUPPORTED_PROVIDERS.map(p => p.key);
      expect(keys).toContain('manual');
      expect(keys).toContain('coingecko');
      expect(keys).toContain('yahoo');
      expect(keys).toContain('kraken');
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

    it('should handle CoinGecko API errors gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'coingecko', price_provider_id: 'bitcoin', currency: 'EUR' },
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

    it('should handle Kraken API errors gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'kraken', price_provider_id: 'XBTUSD' },
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
        json: () => Promise.resolve({
          bitcoin: { usd: 50000, eur: 46000 },
          ethereum: { usd: 3000, eur: 2750 },
        }),
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'coingecko', price_provider_id: 'bitcoin', currency: 'EUR' },
        { id: 2, price_provider: 'coingecko', price_provider_id: 'ethereum', currency: 'USD' },
      ]);

      // Should batch into single CoinGecko call
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(result[1]).toBe(46000); // EUR price for bitcoin
      expect(result[2]).toBe(3000); // USD price for ethereum
    });

    it('should handle CoinGecko successful response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ bitcoin: { usd: 50000, eur: 46000 } }),
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'coingecko', price_provider_id: 'bitcoin', currency: 'EUR' },
      ]);

      expect(result[1]).toBe(46000);
    });

    it('should handle Kraken successful response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          error: [],
          result: { XXBTZUSD: { c: ['50000.00', '1.0'] } },
        }),
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'kraken', price_provider_id: 'XXBTZUSD' },
      ]);

      expect(result[1]).toBe(50000);
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

    it('should handle mixed providers', async () => {
      // Will fail all fetches but should not throw
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network'));

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'coingecko', price_provider_id: 'bitcoin', currency: 'EUR' },
        { id: 2, price_provider: 'yahoo', price_provider_id: 'AAPL', currency: 'USD' },
        { id: 3, price_provider: 'manual', price_provider_id: null },
      ]);

      expect(typeof result).toBe('object');
      // Manual should be skipped, others failed gracefully
    });
  });

  describe('fetchHistoricalPrices', () => {
    it('returns normalized custom history points with filters', async () => {
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
        { fromMs: 1700000050000, toMs: 1700000150000 }
      );

      expect(points).toEqual([
        { timestampMs: 1700000100000, price: 710 },
      ]);
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
