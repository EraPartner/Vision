import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeHandlers = {};
const mockRouter = {
  get: vi.fn((path, ...handlers) => { routeHandlers[`get:${path}`] = handlers[handlers.length - 1]; }),
  post: vi.fn(),
  use: vi.fn(),
};

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
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { ValidationError, AppError } from '../../src/middleware/errorHandler.js';
await import('../../src/routes/marketLookup.js');

function mockResponse() {
  const res = {
    json: vi.fn(),
    send: vi.fn(),
    status: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.ok = (data, meta) => {
    const body = { ok: true, data };
    if (meta) body.meta = meta;
    return res.json(body);
  };
  return res;
}

describe('Market Lookup Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(body.data.quotes).toHaveLength(1);
      expect(body.data.quotes[0]).toMatchObject({
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
      expect(body.data.quotes[0].analystConsensus).toEqual({
        strongBuy: 4,
        buy: 10,
        hold: 3,
        sell: 1,
        strongSell: 0,
      });
      expect(body.data.quotes[0].recentAnalystActions).toHaveLength(1);
    });

    it('should return empty quotes when all symbol quote fetches fail', async () => {
      mockYahooQuote.mockRejectedValue(new Error('upstream quote failure'));
      mockYahooQuoteSummary.mockResolvedValue({});

      const req = { query: { symbols: 'AAPL,MSFT' } };
      const res = mockResponse();

      await routeHandlers['get:/quote'](req, res);

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { quotes: [] } });
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

      expect(mockYahooSearch).toHaveBeenCalledWith('apple', { quotesCount: 8, newsCount: 0 });
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

      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { points: [] } });
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
      expect(payload.points).toHaveLength(1);
      expect(payload.points[0]).toMatchObject({ close: 200, high: 201, low: 199, volume: 10 });
    });

    it('throws AppError (502) when chart request crashes', async () => {
      mockYahooChart.mockRejectedValue(new Error('chart error'));
      const req = { query: { symbol: 'AAPL', range: 'max' } };
      const res = mockResponse();

      await expect(routeHandlers['get:/chart'](req, res)).rejects.toBeInstanceOf(AppError);
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
      expect(body.articles).toHaveLength(2);
      expect(body.articles[0].title).toBe('Unique headline');
      expect(body.articles[0].thumbnail).toBe('https://img.example.com/c.jpg');
      expect(body.articles[1].title).toBe('Shared headline');
      expect(body.articles[1].thumbnail).toBe('https://img.example.com/a.jpg');
    });

    it('should tolerate yahoo search failures and return empty results', async () => {
      mockYahooSearch.mockRejectedValue(new Error('search exploded'));

      const req = { query: { symbols: 'AAPL' } };
      const res = mockResponse();

      await routeHandlers['get:/news'](req, res);

      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ ok: true, data: { articles: [] } });
    });

    it('uses default symbols and caps count at 50', async () => {
      mockYahooSearch.mockResolvedValue({
        news: [{ title: 'One', link: 'l', publisher: 'p', providerPublishTime: 1, thumbnail: {} }],
      });

      const req = { query: { count: '500' } };
      const res = mockResponse();

      await routeHandlers['get:/news'](req, res);

      expect(mockYahooSearch).toHaveBeenCalledTimes(3);
      expect(mockYahooSearch).toHaveBeenCalledWith('SPY', { quotesCount: 0, newsCount: 50 });
      expect(res.json).toHaveBeenCalled();
    });

    it('throws AppError (502) when news query parsing fails unexpectedly', async () => {
      const req = { query: { symbols: 123 } };
      const res = mockResponse();

      await expect(routeHandlers['get:/news'](req, res)).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('GET /quote additional branches', () => {
    it('throws AppError (502) on unexpected quote route failure', async () => {
      const req = { query: { symbols: 123 } };
      const res = mockResponse();

      await expect(routeHandlers['get:/quote'](req, res)).rejects.toBeInstanceOf(AppError);
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

      const quote = res.json.mock.calls[0][0].data.quotes[0];
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

      const quote = res.json.mock.calls[0][0].data.quotes[0];
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

      const article = res.json.mock.calls[0][0].data.articles[0];
      expect(article.thumbnail).toBeNull();
    });
  });
});
