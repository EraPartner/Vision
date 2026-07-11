import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Concurrency for per-holding price fetches (TODO E16): kinesis() and custom()
// ran one sequential `await fetch` per holding (15s / 10s timeouts) — a
// 5-holding Kinesis portfolio was 5 sequential round trips, worst case ~75s
// when an endpoint hung. Both now fan out per holding.

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../src/config/kinesisConfig.js', () => ({
  KINESIS_BASE_URL: 'https://kinesis.example/api',
  KINESIS_DEFAULT_TIMEFRAME: '1d',
  KINESIS_DEFAULT_FROM_DATE: '2020-01-01',
  getKinesisAssetConfig: vi.fn(() => null),
}));
vi.mock('../src/services/currency/currencyConversionService.js', () => ({
  convertToCurrency: vi.fn(async (v) => v),
}));
vi.mock('../src/lib/urlSafety.js', () => ({ assertPublicHttpUrl: vi.fn() }));

import { PROVIDERS } from '../src/services/prices/priceProviderRegistry.js';

const kinesisPayload = (symbol, price) => ({
  ok: true,
  headers: { get: () => null },
  json: async () => ({ [symbol]: [{ createdAt: '2026-07-01T00:00:00Z', price }] }),
});

function kinesisInv(id, symbol) {
  return { id, symbol, currency: 'USD', price_provider_id: symbol };
}

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('kinesis provider concurrency', () => {
  it('fires all per-holding fetches before any response resolves', async () => {
    const resolvers = [];
    fetchMock.mockImplementation((url) => new Promise((resolve) => {
      resolvers.push(() => {
        const symbol = new URL(url).searchParams.get('symbolIds');
        resolve(kinesisPayload(symbol, 42));
      });
    }));

    const investments = [kinesisInv(1, 'KAU_USD'), kinesisInv(2, 'KAG_USD'), kinesisInv(3, 'KPT_USD')];
    const resultPromise = PROVIDERS.kinesis(investments);

    // With the old serial loop only ONE fetch is in flight at this point —
    // the others wait behind the unresolved first response.
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    resolvers.forEach((r) => r());
    const prices = await resultPromise;
    expect(Object.keys(prices)).toHaveLength(3);
    expect(prices[1].price).toBe(42);
  });

  it('one failing holding does not drop the others', async () => {
    fetchMock.mockImplementation(async (url) => {
      const symbol = new URL(url).searchParams.get('symbolIds');
      if (symbol === 'KAG_USD') throw new Error('boom');
      return kinesisPayload(symbol, 10);
    });

    const prices = await PROVIDERS.kinesis([kinesisInv(1, 'KAU_USD'), kinesisInv(2, 'KAG_USD')]);

    expect(prices[1]).toMatchObject({ price: 10 });
    expect(prices[2]).toBeUndefined();
  });
});

describe('custom provider concurrency', () => {
  const customInv = (id, url) => ({ id, price_provider_latest_url: url, price_provider_latest_path: 'p' });

  it('fires all per-holding fetches before any response resolves', async () => {
    const resolvers = [];
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(() => resolve({
        ok: true,
        headers: { get: () => null },
        json: async () => ({ p: 7 }),
      }));
    }));

    const investments = [customInv(1, 'https://a.example/x'), customInv(2, 'https://b.example/x')];
    const resultPromise = PROVIDERS.custom(investments);

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resolvers.forEach((r) => r());
    const prices = await resultPromise;
    expect(prices[1]).toEqual({ price: 7 });
    expect(prices[2]).toEqual({ price: 7 });
  });
});
