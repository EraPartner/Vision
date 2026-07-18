/**
 * Research route validation pins (ZOD-09).
 *
 * Pins the query/body parameter guards across the zod swap: single() array/
 * scalar normalization, per-endpoint symbol requireds, key_type set + default,
 * instrument_key/query requireds, positiveInt coercion, and the macro
 * provider/series_id guards.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('../../src/services/research/researchAggregator.js', () => ({
  researchAggregator: {
    fetch: vi.fn(),
    fetchFundamentals: vi.fn(),
    searchMacro: vi.fn(),
    fetchMacroSeries: vi.fn(),
  },
}));

vi.mock('../../src/services/research/researchMappingService.js', () => ({
  researchMappingService: {
    list: vi.fn(),
    resolve: vi.fn(),
    save: vi.fn(),
    audit: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../src/services/research/researchProviderKeyService.js', () => ({
  listKeyStatuses: vi.fn(),
  setKey: vi.fn(),
  clearKey: vi.fn(),
}));

vi.mock('../../src/services/research/projection/portfolioProjection.js', () => ({
  runPortfolioForecast: vi.fn(),
}));

vi.mock('../../src/services/research/fundamentalsScorecard.js', () => ({
  fundamentalsScorecard: vi.fn(() => ({ score: 1 })),
}));

import { researchAggregator } from '../../src/services/research/researchAggregator.js';
import { researchMappingService } from '../../src/services/research/researchMappingService.js';
import { ValidationError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/research.js');

describe('Research route parameter guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    researchAggregator.fetch.mockResolvedValue({ provider: 'yahoo', source: 'live', data: { x: 1 } });
    researchAggregator.fetchMacroSeries.mockResolvedValue({ provider: 'fred', source: 'live', data: { points: [] } });
    researchMappingService.list.mockResolvedValue([]);
    researchMappingService.resolve.mockResolvedValue({ ok: true });
    researchMappingService.save.mockResolvedValue([]);
  });

  describe('symbol requireds', () => {
    it.each(['get:/quote', 'get:/chart', 'get:/analyst', 'get:/news'])(
      '%s rejects a missing/empty symbol',
      async (key) => {
        await expect(routeHandlers[key]({ query: {} }, createMockResponse()))
          .rejects.toThrow('symbol parameter required');
        await expect(routeHandlers[key]({ query: { symbol: '   ' } }, createMockResponse()))
          .rejects.toBeInstanceOf(ValidationError);
      },
    );

    it('uses the first entry of an array-valued symbol and trims scalars', async () => {
      await routeHandlers['get:/quote']({ query: { symbol: ['AAPL', 'MSFT'] } }, createMockResponse());
      expect(researchAggregator.fetch).toHaveBeenCalledWith('quote', expect.objectContaining({ symbol: 'AAPL' }));

      await routeHandlers['get:/news']({ query: { symbol: '  TSLA  ' } }, createMockResponse());
      expect(researchAggregator.fetch).toHaveBeenLastCalledWith('news', { symbol: 'TSLA' });
    });
  });

  describe('macro series guards', () => {
    it('rejects an unknown provider with the provider list', async () => {
      await expect(routeHandlers['get:/macro/series']({ query: { provider: 'nope', series_id: 'CPIAUCSL' } }, createMockResponse()))
        .rejects.toThrow('provider must be one of: fred, eurostat, dbnomics');
    });

    it('rejects a series_id that fails the provider shape', async () => {
      await expect(routeHandlers['get:/macro/series']({ query: { provider: 'fred', series_id: 'a/b/c' } }, createMockResponse()))
        .rejects.toThrow('valid series_id required for the given provider');
      await expect(routeHandlers['get:/macro/series']({ query: { provider: 'fred' } }, createMockResponse()))
        .rejects.toThrow('valid series_id required for the given provider');
    });

    it('fetches with defaulted range for a valid provider/series pair', async () => {
      await routeHandlers['get:/macro/series']({ query: { provider: 'fred', series_id: 'CPIAUCSL' } }, createMockResponse());
      expect(researchAggregator.fetchMacroSeries).toHaveBeenCalledWith({
        provider: 'fred', seriesId: 'CPIAUCSL', range: '5y',
      });
    });
  });

  describe('mapping guards', () => {
    it('GET /mappings requires instrument_key and defaults key_type to isin', async () => {
      await expect(routeHandlers['get:/mappings']({ query: {} }, createMockResponse()))
        .rejects.toThrow('instrument_key required');

      await routeHandlers['get:/mappings']({ query: { instrument_key: 'US0378331005' } }, createMockResponse());
      expect(researchMappingService.list).toHaveBeenCalledWith('US0378331005', 'isin');
    });

    it('rejects an unknown key_type', async () => {
      await expect(
        routeHandlers['get:/mappings']({ query: { instrument_key: 'X', key_type: 'weird' } }, createMockResponse()),
      ).rejects.toThrow("key_type must be 'isin' or 'internal'");
    });

    it('POST /mappings/resolve requires query and coerces investment_id via parseInt', async () => {
      await expect(
        routeHandlers['post:/mappings/resolve']({ body: { instrument_key: 'X', query: '' } }, createMockResponse()),
      ).rejects.toThrow('query required');

      await routeHandlers['post:/mappings/resolve'](
        { body: { instrument_key: 'X', key_type: 'internal', query: 'apple', investment_id: '5' } },
        createMockResponse(),
      );
      expect(researchMappingService.resolve).toHaveBeenCalledWith(expect.objectContaining({
        instrumentKey: 'X', keyType: 'internal', query: 'apple', investmentId: 5,
      }));

      await routeHandlers['post:/mappings/resolve'](
        { body: { instrument_key: 'X', query: 'apple', investment_id: 'abc' } },
        createMockResponse(),
      );
      expect(researchMappingService.resolve).toHaveBeenLastCalledWith(
        expect.objectContaining({ investmentId: undefined }),
      );
    });

    it('POST /mappings rejects a missing or empty mappings array', async () => {
      for (const mappings of [undefined, 'x', []]) {
        await expect(
          routeHandlers['post:/mappings']({ body: { instrument_key: 'X', mappings } }, createMockResponse()),
        ).rejects.toThrow('mappings must be a non-empty array');
      }
    });

    it('DELETE /mappings/:id keeps parseInt id coercion', async () => {
      researchMappingService.remove.mockResolvedValue(true);
      await routeHandlers['delete:/mappings/:id']({ params: { id: '12abc' } }, createMockResponse());
      expect(researchMappingService.remove).toHaveBeenCalledWith(12);
      await expect(routeHandlers['delete:/mappings/:id']({ params: { id: 'abc' } }, createMockResponse()))
        .rejects.toThrow('valid mapping id required');
    });
  });

  describe('search empty-q short-circuit', () => {
    it('returns an empty payload without calling the aggregator', async () => {
      const res = createMockResponse();
      await routeHandlers['get:/search']({ query: {} }, res);
      expect(researchAggregator.fetch).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].data).toEqual({ items: [] });
    });
  });
});
