import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockLogger } from '../helpers/mockLogger.js';
import { createMockRouter, createMockResponse } from '../helpers/routeHarness.js';

const { router: mockRouter, handlers: routeHandlers } = createMockRouter();

const mockYahooSearch = vi.fn();
const mockYahooQuote = vi.fn();
const mockYahooQuoteSummary = vi.fn();
const mockYahooChart = vi.fn();

vi.mock('express', () => ({
  default: { Router: () => mockRouter },
  Router: () => mockRouter,
}));

vi.mock('yahoo-finance2', () => ({
  default: vi.fn().mockImplementation(function MockYahooFinance() {
    return {
      chart: mockYahooChart,
      quote: mockYahooQuote,
      quoteSummary: mockYahooQuoteSummary,
      search: mockYahooSearch,
    };
  }),
}));

vi.mock('../../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { ValidationError, AppError } from '../../src/middleware/errorHandler.js';
const { __clearQuoteCacheForTests } = await import('../../src/routes/marketLookup.js');

function mockResponse() {
  return createMockResponse();
}

describe('Market Lookup Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The /quote route caches per symbol; clear it so cases don't see each
    // other's cached quotes.
    __clearQuoteCacheForTests();
  });

  describe('GET /quote', () => {
    it('should throw ValidationError when symbols query parameter is missing', async () => {
      const req = { query: {} };
      const res = mockResponse();

      await expect(routeHandlers['get:/quote'](req, res)).rejects.toBeInstanceOf(ValidationError);
    });

    it('should map quote and summary fields into API response', async () => {
      mockYahooQuote.mockResolvedValue({
        symbol: 'AAPL',
        shortName: 'Apple Inc.',
        regularMarketPrice: 190.11,
        regularMarketChange: 1.1,
        regularMarketChangePercent: 0.58,
        currency: 'USD',
        fullExchangeName: 'NasdaqGS',
        quoteType: 'EQUITY',
        regularMarketOpen: 189,
        regularMarketDayHigh: 191,
        regularMarketDayLow: 188,
        regularMarketPreviousClose: 189.01,
        regularMarketVolume: 10,
        averageDailyVolume3Month: 12,
        fiftyTwoWeekHigh: 210,
        fiftyTwoWeekLow: 150,
        trailingPE: 20,
      });
      mockYahooQuoteSummary.mockResolvedValue({
        summaryDetail: {
          marketCap: 300,
          trailingPE: 22,
          forwardPE: 18,
          dividendYield: 0.006,
          beta: 1.1,
        },
        defaultKeyStatistics: {
          priceToBook: 4.4,
          trailingEps: 5.1,
        },
        recommendationTrend: {
          trend: [{ period: '0m', strongBuy: 4, buy: 10, hold: 3, sell: 1, strongSell: 0 }],
        },
        upgradeDowngradeHistory: {
          history: [{ epochGradeDate: 1712440000, firm: 'Firm A', toGrade: 'Buy', action: 'up' }],
        },
      });

      const req = { query: { symbols: 'AAPL' } };
      const res = mockResponse();

      await routeHandlers['get:/quote'](req, res);

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0]).toMatchObject({
        symbol: 'AAPL',
        name: 'Apple Inc.',
        marketCap: 300,
        pe: 22,
        forwardPE: 18,
        dividendYield: 0.006,
        eps: 5.1,
        beta: 1.1,
        priceToBook: 4.4,
      });
      expect(body.data.items[0].analystConsensus).toEqual({
        strongBuy: 4,
        buy: 10,
        hold: 3,
        sell: 1,
        strongSell: 0,
      });
      expect(body.data.items[0].recentAnalystActions).toHaveLength(1);
    });

    it('detail=basic returns price-only fields and skips the quoteSummary call', async () => {
      mockYahooQuote.mockResolvedValue({
        symbol: 'AAPL',
        shortName: 'Apple Inc.',
        regularMarketPrice: 190.11,
        regularMarketChange: 1.1,
        regularMarketChangePercent: 0.58,
        currency: 'USD',
        regularMarketPreviousClose: 189.01,
      });

      const req = { query: { symbols: 'AAPL', detail: 'basic' } };
      const res = mockResponse();

      await routeHandlers['get:/quote'](req, res);

      expect(mockYahooQuoteSummary).not.toHaveBeenCalled();
      const quote = res.json.mock.calls[0][0].data.items[0];
      expect(quote).toMatchObject({
        symbol: 'AAPL',
        name: 'Apple Inc.',
        price: 190.11,
        change: 1.1,
        changePercent: 0.58,
        currency: 'USD',
        prevClose: 189.01,
      });
      expect(quote).not.toHaveProperty('marketCap');
      expect(quote).not.toHaveProperty('analystConsensus');
    });

    it('should return empty quotes when all symbol quote fetches fail', async () => {
      mockYahooQuote.mockRejectedValue(new Error('upstream quote failure'));
      mockYahooQuoteSummary.mockResolvedValue({});

      const req = { query: { symbols: 'AAPL,MSFT' } };
      const res = mockResponse();

      await routeHandlers['get:/quote'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { items: [], total: 0 } });
    });
  });

  describe('GET /search', () => {
    it('returns empty list for empty query', async () => {
      const req = { query: { q: '' } };
      const res = mockResponse();

      await routeHandlers['get:/search'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { items: [] } });
      expect(mockYahooSearch).not.toHaveBeenCalled();
    });

    it('returns mapped search results for non-empty query', async () => {
      mockYahooSearch.mockResolvedValue({
        quotes: [
          {
            symbol: 'AAPL',
            shortname: 'Apple Inc.',
            quoteType: 'EQUITY',
            exchDisp: 'NasdaqGS',
          },
          {
            symbol: 'VUSA.AS',
            longname: 'Vanguard S&P 500 UCITS ETF',
            quoteType: 'ETF',
            exchange: 'AEX',
          },
        ],
      });

      const req = { query: { q: 'apple' } };
      const res = mockResponse();

      await routeHandlers['get:/search'](req, res);

      expect(mockYahooSearch).toHaveBeenCalledWith(
        'apple',
        { quotesCount: 8, newsCount: 0 },
        { validateResult: false },
      );
      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: {
          items: [
            {
              symbol: 'AAPL',
              name: 'Apple Inc.',
              type: 'EQUITY',
              exchange: 'NasdaqGS',
            },
            {
              symbol: 'VUSA.AS',
              name: 'Vanguard S&P 500 UCITS ETF',
              type: 'ETF',
              exchange: 'AEX',
            },
          ],
        },
      });
    });

    it('throws AppError (502) when upstream search throws', async () => {
      mockYahooSearch.mockRejectedValue(new Error('upstream down'));

      const req = { query: { q: 'apple' } };
      const res = mockResponse();

      await expect(routeHandlers['get:/search'](req, res)).rejects.toBeInstanceOf(AppError);
    });

    it('filters entries without symbol and applies fallback fields', async () => {
      mockYahooSearch.mockResolvedValue({
        quotes: [
          { shortname: 'No Symbol' },
          { symbol: 'TSLA' },
        ],
      });

      const req = { query: { q: 'tsla' } };
      const res = mockResponse();

      await routeHandlers['get:/search'](req, res);

      expect(res.json).toHaveBeenCalledWith({
        ok: true,
        data: {
          items: [
            {
              symbol: 'TSLA',
              name: 'TSLA',
              type: 'UNKNOWN',
              exchange: '',
            },
          ],
        },
      });
    });
  });

  describe('GET /chart', () => {
    it('throws ValidationError when symbol is missing', async () => {
      const req = { query: {} };
      const res = mockResponse();

      await expect(routeHandlers['get:/chart'](req, res)).rejects.toBeInstanceOf(ValidationError);
      expect(mockYahooChart).not.toHaveBeenCalled();
    });

    it('returns empty points when chart payload is empty', async () => {
      mockYahooChart.mockResolvedValue(null);

      const req = { query: { symbol: 'AAPL' } };
      const res = mockResponse();

      await routeHandlers['get:/chart'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { items: [], total: 0 } });
    });

    it('maps chart points and filters null closes', async () => {
      mockYahooChart.mockResolvedValue({
        meta: { symbol: 'AAPL', currency: 'USD' },
        quotes: [
          { date: '2026-01-01T00:00:00.000Z', close: null, high: 1, low: 1, volume: 1 },
          { date: '2026-01-02T00:00:00.000Z', close: 200, high: 201, low: 199, volume: 10 },
        ],
      });

      const req = { query: { symbol: 'AAPL', range: '5y', interval: '1wk' } };
      const res = mockResponse();

      await routeHandlers['get:/chart'](req, res);

      const payload = res.json.mock.calls[0][0].data;
      expect(payload.symbol).toBe('AAPL');
      expect(payload.currency).toBe('USD');
      expect(payload.items).toHaveLength(1);
      expect(payload.items[0]).toMatchObject({ close: 200, high: 201, low: 199, volume: 10 });
    });

    it('throws AppError (502) when chart request crashes', async () => {
      mockYahooChart.mockRejectedValue(new Error('chart error'));
      const req = { query: { symbol: 'AAPL', range: 'max' } };
      const res = mockResponse();

      await expect(routeHandlers['get:/chart'](req, res)).rejects.toBeInstanceOf(AppError);
    });

    it('passes validateResult:false so incomplete Yahoo meta degrades instead of 502', async () => {
      mockYahooChart.mockResolvedValue({
        meta: { symbol: 'KAU_EUR', currency: null, regularMarketTime: null },
        quotes: [
          { date: '2026-01-02T00:00:00.000Z', close: 200, high: 201, low: 199, volume: 10 },
        ],
      });

      const req = { query: { symbol: 'KAU_EUR' } };
      const res = mockResponse();

      await routeHandlers['get:/chart'](req, res);

      expect(mockYahooChart).toHaveBeenCalledWith(
        'KAU_EUR',
        expect.any(Object),
        { validateResult: false },
      );
      const payload = res.json.mock.calls[0][0].data;
      expect(payload.items).toHaveLength(1);
    });
  });

  describe('GET /news', () => {
    it('should deduplicate articles by title and normalize thumbnails', async () => {
      mockYahooSearch
        .mockResolvedValueOnce({
          news: [
            {
              title: 'Shared headline',
              link: 'https://example.com/a',
              publisher: 'News A',
              providerPublishTime: 1712300000,
              thumbnail: { resolutions: [{ url: '//img.example.com/a.jpg' }] },
            },
          ],
        })
        .mockResolvedValueOnce({
          news: [
            {
              title: 'Shared headline',
              link: 'https://example.com/b',
              publisher: 'News B',
              providerPublishTime: 1712400000,
              thumbnail: { resolutions: [{ url: 'http://img.example.com/b.jpg' }] },
            },
            {
              title: 'Unique headline',
              link: 'https://example.com/c',
              publisher: 'News C',
              providerPublishTime: 1712500000,
              thumbnail: { resolutions: [{ url: 'https://img.example.com/c.jpg' }] },
            },
          ],
        });

      const req = { query: { symbols: 'AAPL,MSFT', count: '5' } };
      const res = mockResponse();

      await routeHandlers['get:/news'](req, res);

      const body = res.json.mock.calls[0][0].data;
      expect(body.items).toHaveLength(2);
      expect(body.items[0].title).toBe('Unique headline');
      expect(body.items[0].thumbnail).toBe('https://img.example.com/c.jpg');
      expect(body.items[1].title).toBe('Shared headline');
      expect(body.items[1].thumbnail).toBe('https://img.example.com/a.jpg');
    });

    it('should tolerate yahoo search failures and return empty results', async () => {
      mockYahooSearch.mockRejectedValue(new Error('search exploded'));

      const req = { query: { symbols: 'AAPL' } };
      const res = mockResponse();

      await routeHandlers['get:/news'](req, res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { items: [], total: 0 } });
    });

    it('uses default symbols and caps count at 50', async () => {
      mockYahooSearch.mockResolvedValue({
        news: [{ title: 'One', link: 'l', publisher: 'p', providerPublishTime: 1, thumbnail: {} }],
      });

      const req = { query: { count: '500' } };
      const res = mockResponse();

      await routeHandlers['get:/news'](req, res);

      expect(mockYahooSearch).toHaveBeenCalledTimes(3);
      expect(mockYahooSearch).toHaveBeenCalledWith(
        'SPY',
        { quotesCount: 0, newsCount: 50 },
        { validateResult: false },
      );
      expect(res.json).toHaveBeenCalled();
    });

    it('coerces a repeated (array) symbols param instead of throwing', async () => {
      // Express parses `?symbols=AAPL&symbols=MSFT` as an array — the route
      // now joins it to a string rather than letting `.split` throw a 502.
      mockYahooSearch.mockResolvedValue({ news: [] });
      const req = { query: { symbols: ['AAPL', 'MSFT'] } };
      const res = mockResponse();

      await routeHandlers['get:/news'](req, res);

      expect(res.json).toHaveBeenCalled();
      expect(mockYahooSearch).toHaveBeenCalledWith('AAPL', expect.anything(), expect.anything());
      expect(mockYahooSearch).toHaveBeenCalledWith('MSFT', expect.anything(), expect.anything());
    });
  });

  describe('GET /quote additional branches', () => {
    it('coerces a repeated (array) symbols param instead of throwing', async () => {
      mockYahooQuote.mockResolvedValue({ symbol: 'AAPL', regularMarketPrice: 1 });
      mockYahooQuoteSummary.mockResolvedValue({});
      const req = { query: { symbols: ['AAPL', 'MSFT'] } };
      const res = mockResponse();

      await routeHandlers['get:/quote'](req, res);

      expect(res.json).toHaveBeenCalled();
    });

    it('uses summary fallback buckets and quote defaults', async () => {
      mockYahooQuote.mockResolvedValue({ symbol: 'MSFT', regularMarketPrice: 10 });
      mockYahooQuoteSummary.mockResolvedValue({
        recommendationTrend: { trend: [{ period: '1m', strongBuy: 1, buy: 2, hold: 3, sell: 4, strongSell: 5 }] },
        upgradeDowngradeHistory: { history: Array.from({ length: 12 }, (_, i) => ({ epochGradeDate: i, firm: `F${i}`, toGrade: 'Buy', action: 'up' })) },
      });

      const req = { query: { symbols: 'MSFT' } };
      const res = mockResponse();

      await routeHandlers['get:/quote'](req, res);

      const quote = res.json.mock.calls[0][0].data.items[0];
      expect(quote.name).toBe('MSFT');
      expect(quote.currency).toBe('USD');
      expect(quote.analystConsensus).toEqual({ strongBuy: 1, buy: 2, hold: 3, sell: 4, strongSell: 5 });
      expect(quote.recentAnalystActions).toHaveLength(10);
    });

    it('still returns quote when quoteSummary fails', async () => {
      mockYahooQuote.mockResolvedValue({
        symbol: 'NVDA',
        regularMarketPrice: 900,
        regularMarketPreviousClose: 890,
        quoteType: 'EQUITY',
      });
      mockYahooQuoteSummary.mockRejectedValue(new Error('summary unavailable'));

      const req = { query: { symbols: 'NVDA' } };
      const res = mockResponse();

      await routeHandlers['get:/quote'](req, res);

      const quote = res.json.mock.calls[0][0].data.items[0];
      expect(quote.symbol).toBe('NVDA');
      expect(quote.price).toBe(900);
      expect(quote.analystConsensus).toBeNull();
      expect(quote.recentAnalystActions).toEqual([]);
    });
  });

  describe('GET /chart range mapping branches', () => {
    it('handles all supported/default ranges without errors', async () => {
      mockYahooChart.mockResolvedValue({ meta: { symbol: 'AAPL', currency: 'USD' }, quotes: [] });

      const ranges = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', 'max', 'unknown'];
      for (const range of ranges) {
        const req = { query: { symbol: 'AAPL', range, interval: '1d' } };
        const res = mockResponse();
        await routeHandlers['get:/chart'](req, res);
        expect(res.status).not.toHaveBeenCalled();
      }

      expect(mockYahooChart).toHaveBeenCalledTimes(ranges.length);
    });
  });

  describe('GET /news thumbnail normalization branch', () => {
    it('returns null thumbnail when URL is unsupported', async () => {
      mockYahooSearch.mockResolvedValue({
        news: [
          {
            title: 'Unsupported thumb',
            link: 'https://example.com/x',
            publisher: 'Publisher',
            providerPublishTime: 1712600000,
            thumbnail: { resolutions: [{ url: 'ftp://img.example.com/x.jpg' }, { url: 'img.example.com/y.jpg' }] },
          },
        ],
      });

      const req = { query: { symbols: 'AAPL', count: '1' } };
      const res = mockResponse();

      await routeHandlers['get:/news'](req, res);

      const article = res.json.mock.calls[0][0].data.items[0];
      expect(article.thumbnail).toBeNull();
    });
  });
});
