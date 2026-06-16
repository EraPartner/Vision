/**
 * Unit tests for the keyed research provider adapters (ADR-079 / task #4):
 * Twelve Data, Finnhub, FMP, Alpha Vantage. `fetch` is mocked and API keys are
 * set via process.env — these lock the response-normalization logic, not live
 * upstream behavior (the documented shapes still need live verification).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import twelveData from '../../src/services/research/adapters/twelveDataAdapter.js';
import finnhub from '../../src/services/research/adapters/finnhubAdapter.js';
import fmp from '../../src/services/research/adapters/fmpAdapter.js';
import alphaVantage from '../../src/services/research/adapters/alphaVantageAdapter.js';

const ENV = {
  TWELVE_DATA_API_KEY: 'td',
  FINNHUB_API_KEY: 'fh',
  FMP_API_KEY: 'fmp',
  ALPHA_VANTAGE_API_KEY: 'av',
};

// Resolve a mocked HTTP response by matching a route substring against the URL.
function mockFetch(routes) {
  globalThis.fetch = vi.fn(async (url) => {
    const match = routes.find(([needle]) => String(url).includes(needle));
    if (!match) throw new Error(`unmocked URL: ${url}`);
    return { ok: true, text: async () => JSON.stringify(match[1]) };
  });
}

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe('twelveDataAdapter', () => {
  it('normalizes a quote', async () => {
    mockFetch([['/quote', {
      symbol: 'AAPL', name: 'Apple', currency: 'USD', exchange: 'NASDAQ',
      close: '190.5', change: '1.5', percent_change: '0.8', open: '189', high: '191',
      low: '188', previous_close: '189', volume: '1000', fifty_two_week: { high: '200', low: '150' },
    }]]);
    const q = await twelveData.quote('AAPL');
    expect(q).toMatchObject({ symbol: 'AAPL', price: 190.5, changePercent: 0.8, currency: 'USD', high52w: 200, low52w: 150 });
  });

  it('returns chart points oldest-first (provider sends newest-first)', async () => {
    mockFetch([['/time_series', {
      meta: { symbol: 'AAPL', currency: 'USD' },
      values: [
        { datetime: '2026-01-02', open: '2', high: '3', low: '1', close: '2.5', volume: '10' },
        { datetime: '2026-01-01', open: '1', high: '2', low: '0.5', close: '1.5', volume: '5' },
      ],
    }]]);
    const { points, currency } = await twelveData.chart('AAPL', { range: '1mo' });
    expect(currency).toBe('USD');
    expect(points.map((p) => p.close)).toEqual([1.5, 2.5]); // reversed to ascending
  });

  it('throws when the key is missing', async () => {
    delete process.env.TWELVE_DATA_API_KEY;
    await expect(twelveData.quote('AAPL')).rejects.toThrow(/not configured/);
  });

  it('throws on a Twelve Data error envelope', async () => {
    mockFetch([['/quote', { status: 'error', code: 400, message: 'bad symbol' }]]);
    await expect(twelveData.quote('NOPE')).rejects.toThrow(/bad symbol/);
  });
});

describe('finnhubAdapter', () => {
  it('normalizes a quote (c/d/dp → price/change/changePercent)', async () => {
    mockFetch([['/quote', { c: 190.5, d: 1.5, dp: 0.8, h: 191, l: 188, o: 189, pc: 189 }]]);
    const q = await finnhub.quote('AAPL');
    expect(q).toMatchObject({ symbol: 'AAPL', price: 190.5, change: 1.5, changePercent: 0.8, dayHigh: 191 });
  });

  it('maps company news', async () => {
    mockFetch([['/company-news', [
      { headline: 'H1', url: 'http://x', source: 'Reuters', datetime: 1700000000, image: 'http://img' },
    ]]]);
    const { articles } = await finnhub.news('AAPL', { count: 5 });
    expect(articles[0]).toMatchObject({ title: 'H1', publisher: 'Reuters', publishedAt: 1700000000000, relatedSymbols: ['AAPL'] });
  });
});

describe('fmpAdapter', () => {
  it('normalizes a stable quote (changePercentage/yearHigh → changePercent/high52w)', async () => {
    mockFetch([['/quote?', [{
      symbol: 'AAPL', name: 'Apple', price: 190.5, change: 1.5, changePercentage: 0.8,
      open: 189, dayHigh: 191, dayLow: 188, previousClose: 189, volume: 1000, yearHigh: 200, yearLow: 150,
    }]]]);
    const q = await fmp.quote('AAPL');
    expect(q).toMatchObject({ price: 190.5, changePercent: 0.8, high52w: 200, low52w: 150 });
  });

  it('merges stable profile + ratios-ttm + key-metrics-ttm into fundamentals', async () => {
    mockFetch([
      ['/profile?', [{ companyName: 'Apple', currency: 'USD', marketCap: 3e12, beta: 1.2 }]],
      ['/ratios-ttm?', [{ priceToEarningsRatioTTM: 30, priceToBookRatioTTM: 45, dividendYieldTTM: 0.005, netProfitMarginTTM: 0.25, debtToEquityRatioTTM: 0.8 }]],
      ['/key-metrics-ttm?', [{ returnOnEquityTTM: 1.5, freeCashFlowYieldTTM: 0.03 }]],
    ]);
    const f = await fmp.fundamentals('AAPL');
    expect(f).toMatchObject({ name: 'Apple', currency: 'USD', marketCap: 3e12, pe: 30, priceToBook: 45, profitMargin: 0.25, debtToEquity: 0.8, returnOnEquity: 1.5, fcfYield: 0.03 });
  });

  it('builds analyst consensus buckets from stable grades-consensus', async () => {
    mockFetch([
      ['/price-target-consensus?', [{ targetConsensus: 326.47, targetHigh: 400, targetLow: 253 }]],
      ['/grades?', [{ date: '2026-06-09', gradingCompany: 'Needham', previousGrade: 'Hold', newGrade: 'Hold', action: 'maintain' }]],
      ['/grades-consensus?', [{ strongBuy: 1, buy: 69, hold: 33, sell: 7, strongSell: 0, consensus: 'Buy' }]],
    ]);
    const a = await fmp.analyst('AAPL');
    expect(a).toMatchObject({
      targetMean: 326.47,
      numberOfAnalysts: 110,
      consensus: { strongBuy: 1, buy: 69, hold: 33, sell: 7, strongSell: 0 },
    });
    expect(a.recentActions[0]).toMatchObject({ firm: 'Needham', toGrade: 'Hold', action: 'maintain' });
  });
});

describe('alphaVantageAdapter', () => {
  it('normalizes GLOBAL_QUOTE and strips the % from change percent', async () => {
    mockFetch([['GLOBAL_QUOTE', {
      'Global Quote': {
        '01. symbol': 'AAPL', '02. open': '189', '03. high': '191', '04. low': '188',
        '05. price': '190.5', '06. volume': '1000', '08. previous close': '189',
        '09. change': '1.5', '10. change percent': '0.7895%',
      },
    }]]);
    const q = await alphaVantage.quote('AAPL');
    expect(q).toMatchObject({ price: 190.5, change: 1.5, changePercent: 0.7895, dayHigh: 191 });
  });

  it('throws on a rate-limit Note (no silent empty)', async () => {
    mockFetch([['GLOBAL_QUOTE', { Note: 'call frequency exceeded' }]]);
    await expect(alphaVantage.quote('AAPL')).rejects.toThrow(/call frequency/);
  });

  it('returns chart points ascending within the range window', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockFetch([['TIME_SERIES_DAILY', {
      'Time Series (Daily)': {
        [today]: { '1. open': '2', '2. high': '3', '3. low': '1', '4. close': '2.5', '5. volume': '10' },
      },
    }]]);
    const { points } = await alphaVantage.chart('AAPL', { range: '1mo' });
    expect(points).toHaveLength(1);
    expect(points[0].close).toBe(2.5);
  });
});
