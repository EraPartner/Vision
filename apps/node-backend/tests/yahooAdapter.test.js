/**
 * Yahoo research adapter tests (ADR-079).
 * Mocks yahoo-finance2 and asserts the normalized adapter output shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSearch, mockQuote, mockChart, mockQuoteSummary } = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockQuote: vi.fn(),
  mockChart: vi.fn(),
  mockQuoteSummary: vi.fn(),
}));

vi.mock('yahoo-finance2', () => ({
  default: vi.fn().mockImplementation(function MockYahooFinance() {
    return {
      search: mockSearch,
      quote: mockQuote,
      chart: mockChart,
      quoteSummary: mockQuoteSummary,
    };
  }),
}));

import yahooAdapter from '../src/services/research/adapters/yahooAdapter.js';

describe('yahooAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('search', () => {
    it('normalizes quotes and drops entries without a symbol', async () => {
      mockSearch.mockResolvedValue({
        quotes: [
          { symbol: 'AAPL', shortname: 'Apple', quoteType: 'EQUITY', exchDisp: 'NASDAQ' },
          { longname: 'No Symbol Co' }, // dropped (no symbol)
          { symbol: 'BTC-USD', exchange: 'CCC' }, // name falls back to symbol; type UNKNOWN
        ],
      });
      const { items } = await yahooAdapter.search('apple');
      expect(items).toEqual([
        { symbol: 'AAPL', name: 'Apple', type: 'EQUITY', exchange: 'NASDAQ' },
        { symbol: 'BTC-USD', name: 'BTC-USD', type: 'UNKNOWN', exchange: 'CCC' },
      ]);
    });

    it('handles a missing quotes array', async () => {
      mockSearch.mockResolvedValue({});
      const { items } = await yahooAdapter.search('x');
      expect(items).toEqual([]);
    });
  });

  describe('quote', () => {
    it('maps fields with currency/name fallbacks', async () => {
      mockQuote.mockResolvedValue({
        symbol: 'MSFT',
        longName: 'Microsoft Corp',
        regularMarketPrice: 400,
        regularMarketChange: 5,
        regularMarketChangePercent: 1.25,
        fullExchangeName: 'NasdaqGS',
        quoteType: 'EQUITY',
        regularMarketVolume: 1000,
      });
      const q = await yahooAdapter.quote('MSFT');
      expect(q.symbol).toBe('MSFT');
      expect(q.name).toBe('Microsoft Corp');
      expect(q.price).toBe(400);
      expect(q.currency).toBe('USD'); // default
      expect(q.exchange).toBe('NasdaqGS');
      expect(q.volume).toBe(1000);
    });
  });

  describe('chart', () => {
    it('filters null closes and maps points to time/close', async () => {
      mockChart.mockResolvedValue({
        meta: { symbol: 'AAPL', currency: 'USD' },
        quotes: [
          { date: '2024-01-01T00:00:00Z', close: 100, high: 101, low: 99, volume: 10 },
          { date: '2024-01-02T00:00:00Z', close: null }, // dropped
          { date: '2024-01-03T00:00:00Z', close: 102, high: 103, low: 101, volume: 20 },
        ],
      });
      const res = await yahooAdapter.chart('AAPL', { range: '5y' });
      expect(res.symbol).toBe('AAPL');
      expect(res.currency).toBe('USD');
      expect(res.points).toHaveLength(2);
      expect(res.points[0]).toMatchObject({ close: 100, high: 101, low: 99, volume: 10 });
      expect(mockChart).toHaveBeenCalled();
    });

    it('falls back to the symbol arg and empty points when chart result is sparse', async () => {
      mockChart.mockResolvedValue({});
      const res = await yahooAdapter.chart('TSLA', { range: 'unknownRange' });
      expect(res.symbol).toBe('TSLA');
      expect(res.points).toEqual([]);
    });
  });

  describe('fundamentals', () => {
    it('computes fcfYield and normalizes debtToEquity', async () => {
      mockQuoteSummary.mockResolvedValue({
        summaryDetail: { marketCap: 1000, trailingPE: 20, dividendYield: 0.02 },
        defaultKeyStatistics: { pegRatio: 1.5 },
        price: { longName: 'Foo Inc', currency: 'EUR' },
        financialData: { freeCashflow: 100, debtToEquity: 150, profitMargins: 0.3 },
        assetProfile: { sector: 'Tech' },
      });
      const f = await yahooAdapter.fundamentals('FOO');
      expect(f.name).toBe('Foo Inc');
      expect(f.currency).toBe('EUR');
      expect(f.sector).toBe('Tech');
      expect(f.fcfYield).toBeCloseTo(0.1); // 100/1000
      expect(f.debtToEquity).toBeCloseTo(1.5); // 150/100
      expect(f.pe).toBe(20);
    });

    it('leaves fcfYield and debtToEquity undefined when inputs are missing', async () => {
      mockQuoteSummary.mockResolvedValue({});
      const f = await yahooAdapter.fundamentals('BAR');
      expect(f.symbol).toBe('BAR');
      expect(f.name).toBe('BAR');
      expect(f.fcfYield).toBeUndefined();
      expect(f.debtToEquity).toBeUndefined();
    });
  });

  describe('analyst', () => {
    it('picks the 0m consensus bucket and maps recent actions', async () => {
      mockQuoteSummary.mockResolvedValue({
        recommendationTrend: {
          trend: [
            { period: '-1m', strongBuy: 1 },
            { period: '0m', strongBuy: 5, buy: 3, hold: 2 },
          ],
        },
        upgradeDowngradeHistory: {
          history: Array.from({ length: 12 }, (_, i) => ({
            epochGradeDate: i,
            firm: `Firm${i}`,
            toGrade: 'Buy',
            action: 'main',
          })),
        },
        financialData: { targetMeanPrice: 150, numberOfAnalystOpinions: 20 },
      });
      const a = await yahooAdapter.analyst('FOO');
      expect(a.consensus).toEqual({ strongBuy: 5, buy: 3, hold: 2, sell: 0, strongSell: 0 });
      expect(a.targetMean).toBe(150);
      expect(a.numberOfAnalysts).toBe(20);
      expect(a.recentActions).toHaveLength(10); // sliced
    });

    it('returns undefined consensus when there are no trend buckets', async () => {
      mockQuoteSummary.mockResolvedValue({});
      const a = await yahooAdapter.analyst('BAR');
      expect(a.consensus).toBeUndefined();
      expect(a.recentActions).toEqual([]);
    });
  });

  describe('news', () => {
    it('maps articles and picks the best thumbnail, capping count at 50', async () => {
      mockSearch.mockResolvedValue({
        news: [
          {
            title: 'Headline',
            link: 'https://x.com/a',
            publisher: 'Pub',
            providerPublishTime: 1700000000000,
            thumbnail: {
              resolutions: [
                { url: 'bad' }, // not a valid url scheme -> undefined
                { url: '//cdn.example.com/big.jpg' }, // protocol-relative -> https:
              ],
            },
          },
        ],
      });
      const { articles } = await yahooAdapter.news('AAPL', { count: 100 });
      expect(mockSearch).toHaveBeenCalledWith('AAPL', { quotesCount: 0, newsCount: 50 }, expect.anything());
      expect(articles[0].thumbnail).toBe('https://cdn.example.com/big.jpg');
      expect(articles[0].relatedSymbols).toEqual(['AAPL']);
      expect(typeof articles[0].publishedAt).toBe('number');
    });

    it('handles no news and missing thumbnail', async () => {
      mockSearch.mockResolvedValue({ news: [{ title: 'T', link: 'l', publisher: 'p' }] });
      const { articles } = await yahooAdapter.news('X');
      expect(articles[0].thumbnail).toBeUndefined();
      expect(articles[0].publishedAt).toBeUndefined();
    });
  });
});
