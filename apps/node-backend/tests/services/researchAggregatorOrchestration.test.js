/**
 * Orchestration tests for the research aggregator (ADR-079). All providers,
 * quota, cache, and health are injected fakes — no network, no DB, no real time.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { __createResearchAggregator as createResearchAggregator } from '../../src/services/research/researchAggregator.js';
import { createResearchCache } from '../../src/services/research/researchCache.js';

const makeGovernor = (canSpendImpl = () => true) => ({
  canSpend: vi.fn(async (p) => canSpendImpl(p)),
  spend: vi.fn(async () => {}),
});

// 'quote'/'stock' capability chain is [yahoo, twelve_data, finnhub, fmp, alpha_vantage]
// — Yahoo (keyless) is preferred; paid providers are the fallback.
const makeAdapters = (overrides = {}) => ({
  yahoo: { quote: vi.fn(async () => ({ price: 2, src: 'yahoo' })) },
  twelve_data: { quote: vi.fn(async () => ({ price: 1, src: 'twelve_data' })) },
  ...overrides,
});

const allKeyed = () => true;

let recordSuccess;
let recordError;

beforeEach(() => {
  recordSuccess = vi.fn();
  recordError = vi.fn();
});

const build = (deps) =>
  createResearchAggregator({
    cache: createResearchCache(),
    isKeyed: allKeyed,
    recordSuccess,
    recordError,
    ...deps,
  });

describe('researchAggregator.fetch', () => {
  it('returns the first usable provider in the chain and records the spend + health', async () => {
    const adapters = makeAdapters();
    const governor = makeGovernor();
    const agg = build({ adapters, governor });

    const out = await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });

    expect(out.source).toBe('live');
    expect(out.provider).toBe('yahoo'); // first in chain
    expect(out.data).toEqual({ price: 2, src: 'yahoo' });
    expect(adapters.yahoo.quote).toHaveBeenCalledWith('AAPL', { range: undefined, count: undefined });
    expect(adapters.twelve_data.quote).not.toHaveBeenCalled();
    expect(governor.spend).toHaveBeenCalledWith('yahoo');
    expect(recordSuccess).toHaveBeenCalledWith('yahoo');
  });

  it('serves the second call from cache without spending again', async () => {
    const adapters = makeAdapters();
    const governor = makeGovernor();
    const agg = build({ adapters, governor });

    await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });
    const second = await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });

    expect(second.source).toBe('cache');
    expect(second.data).toEqual({ price: 2, src: 'yahoo' });
    expect(adapters.yahoo.quote).toHaveBeenCalledTimes(1);
    expect(governor.spend).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent identical fetches into a single provider call (single-flight)', async () => {
    let resolveQuote;
    const adapters = makeAdapters({
      yahoo: { quote: vi.fn(() => new Promise((r) => { resolveQuote = () => r({ price: 2, src: 'yahoo' }); })) },
    });
    const governor = makeGovernor();
    const agg = build({ adapters, governor });

    // Fire three concurrent identical requests before the first resolves.
    const p1 = agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });
    const p2 = agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });
    const p3 = agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });
    // Let the first fetch reach the (pending) adapter call before resolving it.
    await new Promise((r) => setTimeout(r, 0));
    resolveQuote();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // One outbound call and one quota spend, shared by all three callers.
    expect(adapters.yahoo.quote).toHaveBeenCalledTimes(1);
    expect(governor.spend).toHaveBeenCalledTimes(1);
    expect(r1.data).toEqual({ price: 2, src: 'yahoo' });
    expect(r2.data).toEqual({ price: 2, src: 'yahoo' });
    expect(r3.data).toEqual({ price: 2, src: 'yahoo' });

    // After settling, the in-flight entry is cleared and the next call is a cache hit.
    const fourth = await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });
    expect(fourth.source).toBe('cache');
    expect(adapters.yahoo.quote).toHaveBeenCalledTimes(1);
  });

  it('skips a quota-exhausted provider and falls through to the next', async () => {
    const adapters = makeAdapters();
    const governor = makeGovernor((p) => p !== 'yahoo'); // yahoo tapped out
    const agg = build({ adapters, governor });

    const out = await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });

    expect(out.provider).toBe('twelve_data');
    expect(adapters.yahoo.quote).not.toHaveBeenCalled();
    expect(adapters.twelve_data.quote).toHaveBeenCalledTimes(1);
  });

  it('falls through on a provider error and records the health error', async () => {
    const adapters = makeAdapters({
      yahoo: { quote: vi.fn(async () => { throw new Error('upstream 502'); }) },
    });
    const governor = makeGovernor();
    const agg = build({ adapters, governor });

    const out = await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });

    expect(out.provider).toBe('twelve_data');
    expect(recordError).toHaveBeenCalledWith('yahoo', expect.any(Error));
    expect(recordSuccess).toHaveBeenCalledWith('twelve_data');
  });

  it('drops unkeyed providers from the chain', async () => {
    const adapters = makeAdapters();
    const governor = makeGovernor();
    const agg = build({ adapters, governor, isKeyed: (p) => p !== 'twelve_data' });

    const out = await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });

    expect(out.provider).toBe('yahoo');
    expect(adapters.twelve_data.quote).not.toHaveBeenCalled();
  });

  it('reports unavailable when no provider can serve the request', async () => {
    const adapters = makeAdapters();
    const governor = makeGovernor(() => false); // everyone tapped out
    const agg = build({ adapters, governor });

    const out = await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });

    expect(out.source).toBe('unavailable');
    expect(out.provider).toBeUndefined();
    expect(out.attempted).toEqual([
      { provider: 'yahoo', skipped: 'quota' },
      { provider: 'twelve_data', skipped: 'quota' },
    ]);
  });
});

describe('researchAggregator.fetchFundamentals (FMP + Yahoo merge)', () => {
  const makeFundamentalsAdapters = (overrides = {}) => ({
    fmp: {
      fundamentals: vi.fn(async () => ({
        symbol: 'AAPL', pe: 30, interestCoverage: 12, forwardPE: null, revenue: null,
      })),
    },
    yahoo: {
      fundamentals: vi.fn(async () => ({
        symbol: 'AAPL', pe: 28, forwardPE: 25, revenue: 1000, freeCashFlow: 500,
      })),
    },
    ...overrides,
  });

  it('merges FMP over Yahoo per field and keeps each provider\'s unique fields', async () => {
    const adapters = makeFundamentalsAdapters();
    const agg = build({ adapters, governor: makeGovernor() });

    const out = await agg.fetchFundamentals({ symbol: 'AAPL' });

    expect(out.source).toBe('live');
    expect(out.provider).toBe('fmp+yahoo');
    expect(out.data).toMatchObject({
      pe: 30, // shared → FMP wins
      interestCoverage: 12, // FMP-only
      forwardPE: 25, // FMP null → Yahoo fills
      revenue: 1000, // FMP null → Yahoo fills
      freeCashFlow: 500, // Yahoo-only
    });
    expect(adapters.fmp.fundamentals).toHaveBeenCalledTimes(1);
    expect(adapters.yahoo.fundamentals).toHaveBeenCalledTimes(1);
  });

  it('falls back to Yahoo-only when FMP is unkeyed', async () => {
    const adapters = makeFundamentalsAdapters();
    const agg = build({ adapters, governor: makeGovernor(), isKeyed: (p) => p !== 'fmp' });

    const out = await agg.fetchFundamentals({ symbol: 'AAPL' });

    expect(out.provider).toBe('yahoo');
    expect(out.data).toMatchObject({ pe: 28, forwardPE: 25 });
    expect(adapters.fmp.fundamentals).not.toHaveBeenCalled();
  });

  it('uses FMP alone when Yahoo throws, recording the health error', async () => {
    const adapters = makeFundamentalsAdapters({
      yahoo: { fundamentals: vi.fn(async () => { throw new Error('yahoo 502'); }) },
    });
    const agg = build({ adapters, governor: makeGovernor() });

    const out = await agg.fetchFundamentals({ symbol: 'AAPL' });

    expect(out.provider).toBe('fmp');
    expect(out.data).toMatchObject({ pe: 30 });
    expect(recordError).toHaveBeenCalledWith('yahoo', expect.any(Error));
  });

  it('reports unavailable when both providers fail', async () => {
    const adapters = makeFundamentalsAdapters({
      fmp: { fundamentals: vi.fn(async () => { throw new Error('fmp down'); }) },
      yahoo: { fundamentals: vi.fn(async () => { throw new Error('yahoo down'); }) },
    });
    const agg = build({ adapters, governor: makeGovernor() });

    const out = await agg.fetchFundamentals({ symbol: 'AAPL' });

    expect(out.source).toBe('unavailable');
    expect(out.provider).toBeUndefined();
  });
});
