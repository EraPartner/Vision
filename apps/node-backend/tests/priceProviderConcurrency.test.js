import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { mockLogger } from './helpers/mockLogger.ts';
// Per-holding work remains concurrent, with a bounded number of active requests.

vi.mock('../src/config/logger.ts', () => ({
  logger: mockLogger(),
}));
vi.mock('../src/config/kinesisConfig.ts', () => ({
  KINESIS_BASE_URL: 'https://kinesis.example/api',
  KINESIS_DEFAULT_TIMEFRAME: '1d',
  KINESIS_DEFAULT_FROM_DATE: '2020-01-01',
  getKinesisAssetConfig: vi.fn(() => null),
}));
vi.mock('../src/services/currency/currencyConversionService.ts', () => ({
  convertToCurrency: vi.fn(async (v) => v),
}));
vi.mock('../src/lib/urlSafety.ts', () => ({ assertPublicHttpUrl: vi.fn() }));

const yahoo = vi.hoisted(() => ({ quote: vi.fn(), chart: vi.fn() }));
vi.mock("../src/services/prices/yahooClient.ts", () => ({
  getYahooClient: vi.fn(async () => yahoo),
}));

import { PROVIDERS } from '../src/services/prices/priceProviderRegistry.ts';

const kinesisPayload = (symbol, price) => ({
  ok: true,
  headers: { get: () => null },
  json: async () => ({ [symbol]: [{ createdAt: '2026-07-01T00:00:00Z', price }] }),
});

function kinesisInv(id, symbol) {
  return { id, symbol, currency: 'USD', price_provider_id: symbol };
}

let fetchMock;

// Hold response bodies open, then finish each wave backwards. This measures
// active work across body reads, rather than just the instant fetch() resolves.
function bodyGate() {
  let active = 0;
  let peak = 0;
  const pending = [];
  return {
    get peak() {
      return peak;
    },
    async read(makePayload) {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => pending.push(resolve));
      try {
        return makePayload();
      } finally {
        active -= 1;
      }
    },
    async drain(resultPromise) {
      let finished = false;
      resultPromise.then(() => {
        finished = true;
      });
      while (!finished) {
        await vi.waitFor(() =>
          expect(finished || pending.length > 0).toBe(true),
        );
        pending
          .splice(0)
          .reverse()
          .forEach((resolve) => resolve());
        await new Promise((resolve) => setImmediate(resolve));
      }
      return resultPromise;
    },
  };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('kinesis provider concurrency', () => {
  it("caps 40 holdings at six active bodies and continues after a failure", async () => {
    const gate = bodyGate();
    fetchMock.mockImplementation(async (url) => {
      const symbol = new URL(url).searchParams.get("symbolIds");
      return {
        ok: true,
        headers: { get: () => null },
        json: () =>
          gate.read(() => {
            if (symbol === "TEST13_USD") throw new Error("body failed");
            return {
              [symbol]: [{ createdAt: "2026-07-01T00:00:00Z", price: 42 }],
            };
          }),
      };
    });
    const investments = Array.from({ length: 40 }, (_, i) =>
      kinesisInv(i + 1, `TEST${i + 1}_USD`),
    );
    const resultPromise = PROVIDERS.kinesis(investments);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    expect(gate.peak).toBe(6);
    const prices = await gate.drain(resultPromise);
    expect(fetchMock).toHaveBeenCalledTimes(40);
    expect(gate.peak).toBe(6);
    expect(Object.keys(prices)).toHaveLength(39);
    expect(prices[13]).toBeUndefined();
    expect(prices[40]).toEqual({ price: 42, currency: "USD", source: "live" });
  });

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

  it("caps 40 holdings including history fallbacks and isolates failed holdings", async () => {
    const gate = bodyGate();
    fetchMock.mockImplementation(async (url) => {
      const [, kind, rawId] = new URL(url).pathname.split("/");
      const id = Number(rawId);
      return {
        ok: true,
        headers: { get: () => null },
        json: () =>
          gate.read(() => {
            if (id === 17 || (id === 13 && kind === "latest"))
              throw new Error("unavailable");
            if (kind === "history")
              return {
                points: [{ timestamp_ms: 1_700_000_000_000, price: 13 }],
              };
            return { p: id };
          }),
      };
    });
    const investments = Array.from({ length: 40 }, (_, i) => ({
      ...customInv(i + 1, `https://provider.example/latest/${i + 1}`),
      price_provider_history_url: `https://provider.example/history/${i + 1}`,
    }));
    const resultPromise = PROVIDERS.custom(investments);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    const prices = await gate.drain(resultPromise);
    expect(gate.peak).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(42);
    expect(Object.keys(prices)).toHaveLength(39);
    expect(prices[13]).toEqual({ price: 13 });
    expect(prices[17]).toBeUndefined();
    expect(prices[40]).toEqual({ price: 40 });
  });

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

describe("Yahoo fallback concurrency", () => {
  it.each(["partial", "failed"])(
    "caps chart fallbacks after a %s batch and tolerates one bad symbol",
    async (mode) => {
      const gate = bodyGate();
      if (mode === "failed")
        yahoo.quote.mockRejectedValue(new Error("batch failed"));
      else
        yahoo.quote.mockResolvedValue([
          { symbol: "TEST0", regularMarketPrice: 100, currency: "EUR" },
        ]);
      yahoo.chart.mockImplementation((symbol) =>
        gate.read(() => {
          if (symbol === "TEST13") throw new Error("chart failed");
          return { quotes: [{ close: 42 }] };
        }),
      );
      const symbols = Array.from({ length: 40 }, (_, i) => `TEST${i}`);
      const resultPromise = PROVIDERS.yahoo(symbols);
      await vi.waitFor(() => expect(yahoo.chart).toHaveBeenCalledTimes(6));
      const prices = await gate.drain(resultPromise);
      expect(yahoo.quote).toHaveBeenCalledTimes(1);
      expect(yahoo.quote).toHaveBeenCalledWith(symbols);
      expect(yahoo.chart).toHaveBeenCalledTimes(mode === "failed" ? 40 : 39);
      expect(gate.peak).toBe(6);
      expect(Object.keys(prices)).toHaveLength(39);
      expect(prices.TEST13).toBeUndefined();
      expect(prices.TEST39).toEqual({
        price: 42,
        currency: "USD",
        source: "close",
      });
      expect(prices.TEST0).toEqual(
        mode === "failed"
          ? { price: 42, currency: "USD", source: "close" }
          : { price: 100, currency: "EUR", source: "live" },
      );
    },
  );
});
