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

await import('../../src/routes/marketLookup.js');

describe('Market Lookup Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /quote', () => {
    it('should return 400 when symbols query parameter is missing', async () => {
      const req = { query: {} };
      const res = mockResponse();

      await routeHandlers['get:/quote'](req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ detail: 'symbols parameter required' });
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
      expect(body.quotes).toHaveLength(1);
      expect(body.quotes[0]).toMatchObject({
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
      expect(body.quotes[0].analystConsensus).toEqual({
        strongBuy: 4,
        buy: 10,
        hold: 3,
        sell: 1,
        strongSell: 0,
      });
      expect(body.quotes[0].recentAnalystActions).toHaveLength(1);
    });

    it('should return empty quotes when all symbol quote fetches fail', async () => {
      mockYahooQuote.mockRejectedValue(new Error('upstream quote failure'));
      mockYahooQuoteSummary.mockResolvedValue({});

      const req = { query: { symbols: 'AAPL,MSFT' } };
      const res = mockResponse();

      await routeHandlers['get:/quote'](req, res);

      expect(res.json).toHaveBeenCalledWith({ quotes: [] });
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

      const body = res.json.mock.calls[0][0];
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
      expect(res.json).toHaveBeenCalledWith({ articles: [] });
    });
  });
});

function mockResponse() {
  const res = {
    json: vi.fn(),
    send: vi.fn(),
    status: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}
