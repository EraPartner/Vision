import { describe, it, expect, vi, beforeEach } from 'vitest';

// yahoo-finance2 is imported lazily (deferred off the pre-listen boot graph) via
// a shared module-cached accessor. Assert it constructs on first use and caches.

const ctor = vi.fn(function MockYahoo() {});
vi.mock('yahoo-finance2', () => ({ default: ctor }));

import {
  getYahooClient,
  parseYahooPayload,
  requireYahooPayload,
  yahooChartResultSchema,
  yahooDateMs,
  yahooQuoteSchema,
  yahooSearchResultSchema,
  __resetYahooClientForTests,
} from '../src/services/prices/yahooClient.ts';

beforeEach(() => {
  __resetYahooClientForTests();
  ctor.mockClear();
});

describe('getYahooClient', () => {
  it('lazily constructs a client and returns the same cached instance', async () => {
    const a = await getYahooClient();
    const b = await getYahooClient();
    expect(a).toBe(b);
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(ctor).toHaveBeenCalledWith({ suppressNotices: ['yahooSurvey'] });
  });
});

describe('Yahoo payload narrowing (NO_VALIDATE results)', () => {
  it('keeps well-typed fields and degrades wrongly typed ones to undefined', () => {
    const quote = parseYahooPayload(yahooQuoteSchema, {
      symbol: 'AAPL',
      regularMarketPrice: 'not-a-number',
      regularMarketChange: null,
      currency: 42,
    });
    expect(quote).toMatchObject({ symbol: 'AAPL', regularMarketChange: null });
    expect(quote?.regularMarketPrice).toBeUndefined();
    expect(quote?.currency).toBeUndefined();
  });

  it('skips non-object list entries and keeps entries without optional fields', () => {
    const result = parseYahooPayload(yahooSearchResultSchema, {
      quotes: 'nope',
      news: [null, 7, { title: 'T' }],
    });
    expect(result?.quotes).toEqual([]);
    expect(result?.news).toEqual([{ title: 'T' }]);
  });

  it('returns undefined for a non-object payload, which requireYahooPayload rejects', () => {
    expect(parseYahooPayload(yahooChartResultSchema, undefined)).toBeUndefined();
    expect(() => requireYahooPayload(yahooSearchResultSchema, null, 'search')).toThrow(
      'Yahoo search returned no result',
    );
  });

  it('yahooDateMs mirrors new Date(value).getTime()', () => {
    const date = new Date('2025-04-15T00:00:00Z');
    expect(yahooDateMs(date)).toBe(date.getTime());
    expect(yahooDateMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(yahooDateMs('2025-04-15T00:00:00Z')).toBe(date.getTime());
    expect(yahooDateMs(null)).toBe(0);
    expect(yahooDateMs(undefined)).toBeNaN();
  });
});
