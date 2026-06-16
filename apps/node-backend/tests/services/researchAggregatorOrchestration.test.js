/**
 * Orchestration tests for the research aggregator (ADR-079). All providers,
 * quota, cache, and health are injected fakes — no network, no DB, no real time.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createResearchAggregator } from '../../src/services/research/researchAggregator.js';
import { createResearchCache } from '../../src/services/research/researchCache.js';

const makeGovernor = (canSpendImpl = () => true) => ({
  canSpend: vi.fn(async (p) => canSpendImpl(p)),
  spend: vi.fn(async () => {}),
});

// 'quote'/'stock' capability chain is [twelve_data, yahoo, finnhub, fmp, alpha_vantage].
const makeAdapters = (overrides = {}) => ({
  twelve_data: { quote: vi.fn(async () => ({ price: 1, src: 'twelve_data' })) },
  yahoo: { quote: vi.fn(async () => ({ price: 2, src: 'yahoo' })) },
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
    expect(out.provider).toBe('twelve_data'); // first in chain
    expect(out.data).toEqual({ price: 1, src: 'twelve_data' });
    expect(adapters.twelve_data.quote).toHaveBeenCalledWith('AAPL', { range: undefined, count: undefined });
    expect(adapters.yahoo.quote).not.toHaveBeenCalled();
    expect(governor.spend).toHaveBeenCalledWith('twelve_data');
    expect(recordSuccess).toHaveBeenCalledWith('twelve_data');
  });

  it('serves the second call from cache without spending again', async () => {
    const adapters = makeAdapters();
    const governor = makeGovernor();
    const agg = build({ adapters, governor });

    await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });
    const second = await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });

    expect(second.source).toBe('cache');
    expect(second.data).toEqual({ price: 1, src: 'twelve_data' });
    expect(adapters.twelve_data.quote).toHaveBeenCalledTimes(1);
    expect(governor.spend).toHaveBeenCalledTimes(1);
  });

  it('skips a quota-exhausted provider and falls through to the next', async () => {
    const adapters = makeAdapters();
    const governor = makeGovernor((p) => p !== 'twelve_data'); // twelve_data tapped out
    const agg = build({ adapters, governor });

    const out = await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });

    expect(out.provider).toBe('yahoo');
    expect(adapters.twelve_data.quote).not.toHaveBeenCalled();
    expect(adapters.yahoo.quote).toHaveBeenCalledTimes(1);
  });

  it('falls through on a provider error and records the health error', async () => {
    const adapters = makeAdapters({
      twelve_data: { quote: vi.fn(async () => { throw new Error('upstream 502'); }) },
    });
    const governor = makeGovernor();
    const agg = build({ adapters, governor });

    const out = await agg.fetch('quote', { symbol: 'AAPL', assetClass: 'stock' });

    expect(out.provider).toBe('yahoo');
    expect(recordError).toHaveBeenCalledWith('twelve_data', expect.any(Error));
    expect(recordSuccess).toHaveBeenCalledWith('yahoo');
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
      { provider: 'twelve_data', skipped: 'quota' },
      { provider: 'yahoo', skipped: 'quota' },
    ]);
  });
});
