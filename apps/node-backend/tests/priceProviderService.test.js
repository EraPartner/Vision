/**
 * Price Provider Service tests.
 * Tests price fetching from CoinGecko, Yahoo, Kraken, and custom endpoints.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { fetchLivePrices, SUPPORTED_PROVIDERS } from '../src/services/priceProviderService.js';

describe('Price Provider Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
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
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

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
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          quoteResponse: {
            result: [{ symbol: 'AAPL', regularMarketPrice: 175.50, currency: 'USD' }],
          },
        }),
      });

      const result = await fetchLivePrices([
        { id: 1, price_provider: 'yahoo', price_provider_id: 'AAPL', currency: 'USD' },
      ]);

      expect(result[1]).toBe(175.50);
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
});
