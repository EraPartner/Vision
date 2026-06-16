/**
 * Tests for the research symbol-mapping service (ADR-079): auto-propose resolve,
 * confirmed-mapping reuse, quota/keyed gating, save/remove, and the cross-provider
 * self-audit. Repo, adapters, governor, and health are injected fakes.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createResearchMappingService,
  analyzeQuotes,
} from '../../src/services/research/researchMappingService.js';

const KEY = 'US0378331005';
const TYPE = 'isin';

const makeRepo = (seed = []) => {
  let rows = seed.map((r, i) => ({ id: r.id ?? i + 1, verified_at: undefined, ...r }));
  return {
    rows: () => rows,
    listByInstrument: vi.fn(async (k, t) => rows.filter((r) => r.instrument_key === k && r.key_type === t)),
    upsert: vi.fn(async (m) => {
      const idx = rows.findIndex(
        (r) => r.instrument_key === m.instrumentKey && r.key_type === m.keyType && r.provider === m.provider,
      );
      const row = {
        id: idx >= 0 ? rows[idx].id : rows.length + 1,
        instrument_key: m.instrumentKey,
        key_type: m.keyType,
        provider: m.provider,
        provider_symbol: m.providerSymbol,
        resolved_name: m.resolvedName,
        exchange: m.exchange,
        currency: m.currency,
        status: m.status,
        verified_at: undefined,
      };
      if (idx >= 0) rows[idx] = row;
      else rows.push(row);
      return row;
    }),
    deleteById: vi.fn(async (id) => {
      const before = rows.length;
      rows = rows.filter((r) => r.id !== id);
      return rows.length < before;
    }),
    markVerified: vi.fn(async (k, t) => {
      let n = 0;
      rows.forEach((r) => {
        if (r.instrument_key === k && r.key_type === t) {
          r.verified_at = 'now';
          n += 1;
        }
      });
      return n;
    }),
  };
};

const governorAllow = () => ({ canSpend: vi.fn(async () => true), spend: vi.fn(async () => {}) });

let recordSuccess;
let recordError;
beforeEach(() => {
  recordSuccess = vi.fn();
  recordError = vi.fn();
});

const build = (deps) =>
  createResearchMappingService({ recordSuccess, recordError, ...deps });

describe('researchMappingService.resolve', () => {
  it('auto-proposes the top search hit for a keyed, search-capable provider', async () => {
    const adapters = {
      yahoo: { search: vi.fn(async () => ({ items: [{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ' }] })) },
    };
    const governor = governorAllow();
    const svc = build({ repo: makeRepo(), adapters, governor, isKeyed: (p) => p === 'yahoo' });

    const { proposals } = await svc.resolve({ instrumentKey: KEY, keyType: TYPE, assetClass: 'stock', query: 'apple' });

    const yahoo = proposals.find((p) => p.provider === 'yahoo');
    expect(yahoo).toMatchObject({ status: 'auto', providerSymbol: 'AAPL', resolvedName: 'Apple Inc.' });
    expect(yahoo.candidates).toHaveLength(1);
    expect(governor.spend).toHaveBeenCalledWith('yahoo');
    expect(recordSuccess).toHaveBeenCalledWith('yahoo');
  });

  it('keeps an existing confirmed mapping without re-searching', async () => {
    const adapters = { yahoo: { search: vi.fn() } };
    const repo = makeRepo([
      { instrument_key: KEY, key_type: TYPE, provider: 'yahoo', provider_symbol: 'AAPL', resolved_name: 'Apple Inc.', status: 'confirmed' },
    ]);
    const svc = build({ repo, adapters, governor: governorAllow(), isKeyed: () => true });

    const { proposals } = await svc.resolve({ instrumentKey: KEY, keyType: TYPE, assetClass: 'stock', query: 'apple' });

    const yahoo = proposals.find((p) => p.provider === 'yahoo');
    expect(yahoo).toMatchObject({ status: 'confirmed', providerSymbol: 'AAPL', fromStore: true });
    expect(adapters.yahoo.search).not.toHaveBeenCalled();
  });

  it('marks a provider skipped when its quota is exhausted', async () => {
    const adapters = { yahoo: { search: vi.fn() } };
    const governor = { canSpend: vi.fn(async () => false), spend: vi.fn() };
    const svc = build({ repo: makeRepo(), adapters, governor, isKeyed: () => true });

    const { proposals } = await svc.resolve({ instrumentKey: KEY, keyType: TYPE, assetClass: 'stock', query: 'apple' });

    expect(proposals.find((p) => p.provider === 'yahoo')).toMatchObject({ status: 'skipped', reason: 'quota' });
    expect(adapters.yahoo.search).not.toHaveBeenCalled();
  });

  it('surfaces an existing mapping for an unkeyed provider instead of searching', async () => {
    const adapters = {
      yahoo: { search: vi.fn(async () => ({ items: [] })) },
      twelve_data: { search: vi.fn() },
    };
    const repo = makeRepo([
      { instrument_key: KEY, key_type: TYPE, provider: 'twelve_data', provider_symbol: 'AAPL', status: 'auto' },
    ]);
    const svc = build({ repo, adapters, governor: governorAllow(), isKeyed: (p) => p === 'yahoo' });

    const { proposals } = await svc.resolve({ instrumentKey: KEY, keyType: TYPE, assetClass: 'stock', query: 'apple' });

    expect(proposals.find((p) => p.provider === 'twelve_data')).toMatchObject({
      status: 'auto',
      providerSymbol: 'AAPL',
      fromStore: true,
    });
    expect(adapters.twelve_data.search).not.toHaveBeenCalled();
  });
});

describe('researchMappingService.save / remove', () => {
  it('upserts each mapping (defaulting status to confirmed) and returns the stored set', async () => {
    const repo = makeRepo();
    const svc = build({ repo, adapters: {}, governor: governorAllow() });

    const rows = await svc.save({
      instrumentKey: KEY,
      keyType: TYPE,
      mappings: [
        { provider: 'yahoo', providerSymbol: 'AAPL', resolvedName: 'Apple', exchange: 'NASDAQ', currency: 'USD' },
        { provider: 'twelve_data', provider_symbol: 'AAPL' },
      ],
    });

    expect(repo.upsert).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'confirmed')).toBe(true);
  });

  it('removes a mapping by id', async () => {
    const repo = makeRepo([{ id: 5, instrument_key: KEY, key_type: TYPE, provider: 'yahoo' }]);
    const svc = build({ repo, adapters: {}, governor: governorAllow() });

    expect(await svc.remove(5)).toBe(true);
    expect(repo.rows()).toHaveLength(0);
  });
});

describe('researchMappingService.audit', () => {
  it('flags currency mismatch + price outlier across providers and stamps verified', async () => {
    const adapters = {
      yahoo: { quote: vi.fn(async () => ({ currency: 'USD', price: 100 })) },
      twelve_data: { quote: vi.fn(async () => ({ currency: 'EUR', price: 45 })) },
    };
    const repo = makeRepo([
      { instrument_key: KEY, key_type: TYPE, provider: 'yahoo', provider_symbol: 'AAPL' },
      { instrument_key: KEY, key_type: TYPE, provider: 'twelve_data', provider_symbol: 'AAPL' },
    ]);
    const svc = build({ repo, adapters, governor: governorAllow(), isKeyed: () => true });

    const result = await svc.audit({ instrumentKey: KEY, keyType: TYPE });

    expect(result.ok).toBe(false);
    expect(result.discrepancies.map((d) => d.type)).toContain('currency_mismatch');
    expect(result.discrepancies.some((d) => d.type === 'price_outlier' && d.provider === 'twelve_data')).toBe(true);
    expect(repo.markVerified).toHaveBeenCalledWith(KEY, TYPE);
  });
});

describe('analyzeQuotes', () => {
  it('returns no discrepancies when currencies match and prices agree', () => {
    expect(
      analyzeQuotes([
        { provider: 'a', currency: 'USD', price: 100 },
        { provider: 'b', currency: 'USD', price: 101 },
      ]),
    ).toEqual([]);
  });

  it('flags a currency mismatch', () => {
    const out = analyzeQuotes([
      { provider: 'a', currency: 'USD', price: 100 },
      { provider: 'b', currency: 'EUR', price: 100 },
    ]);
    expect(out).toEqual([{ type: 'currency_mismatch', currencies: ['USD', 'EUR'] }]);
  });
});
