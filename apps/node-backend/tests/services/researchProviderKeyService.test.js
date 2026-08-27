/**
 * Tests for the research provider API-key service (ADR-079 / task #12):
 * Settings-managed keys override env, masking, set/clear, and hydration. The
 * repository is mocked; providerKeys' in-memory overrides are reset per test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/repositories/providerApiKeyRepository.js', () => ({
  listAll: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

import * as keyRepo from '../../src/repositories/providerApiKeyRepository.js';
import {
  listKeyStatuses,
  setKey,
  clearKey,
  hydrate,
} from '../../src/services/research/researchProviderKeyService.js';
import {
  providerKey,
  requireProviderKey,
  keySource,
  loadKeyOverrides,
} from '../../src/services/research/providerKeys.js';

const PROVIDER_ENV = ['TWELVE_DATA_API_KEY', 'FINNHUB_API_KEY', 'FMP_API_KEY', 'ALPHA_VANTAGE_API_KEY', 'FRED_API_KEY'];

beforeEach(() => {
  vi.clearAllMocks();
  loadKeyOverrides([]); // reset in-memory overrides
  for (const v of PROVIDER_ENV) delete process.env[v]; // deterministic env
});

describe('listKeyStatuses', () => {
  it('reports none/env/settings sources and never leaks the full key', async () => {
    process.env.FMP_API_KEY = 'env-fmp-key-9999';
    await setKey('finnhub', 'settings-finnhub-1234');

    const list = await listKeyStatuses();
    const byProvider = Object.fromEntries(list.map((p) => [p.provider, p]));

    expect(byProvider.twelve_data).toMatchObject({ configured: false, source: 'none', masked: undefined });
    expect(byProvider.fmp).toMatchObject({ configured: true, source: 'env', masked: '••••9999' });
    expect(byProvider.finnhub).toMatchObject({ configured: true, source: 'settings', masked: '••••1234' });
    // No full key value anywhere in the payload.
    expect(JSON.stringify(list)).not.toContain('settings-finnhub-1234');
  });
});

describe('setKey', () => {
  it('persists, overrides env, and takes effect immediately', async () => {
    process.env.FMP_API_KEY = 'env-value';
    await setKey('fmp', '  settings-value  ');
    expect(keyRepo.upsert).toHaveBeenCalledWith('fmp', 'settings-value'); // trimmed
    expect(providerKey('fmp')).toBe('settings-value'); // override wins over env
    expect(keySource('fmp')).toBe('settings');
  });

  it('rejects an unknown provider', async () => {
    await expect(setKey('bogus', 'x')).rejects.toThrow(/Unknown keyed provider/);
    expect(keyRepo.upsert).not.toHaveBeenCalled();
  });

  it('rejects an empty key', async () => {
    await expect(setKey('fmp', '   ')).rejects.toThrow(/non-empty/);
    expect(keyRepo.upsert).not.toHaveBeenCalled();
  });
});

describe('requireProviderKey', () => {
  it('returns the same effective settings-over-env key as providerKey', () => {
    process.env.FMP_API_KEY = 'env-value';
    loadKeyOverrides([{ provider: 'fmp', api_key: 'settings-value' }]);
    expect(requireProviderKey('fmp')).toBe('settings-value');
  });

  it.each([
    ['twelve_data', 'TWELVE_DATA_API_KEY'],
    ['finnhub', 'FINNHUB_API_KEY'],
    ['fmp', 'FMP_API_KEY'],
    ['alpha_vantage', 'ALPHA_VANTAGE_API_KEY'],
    ['fred', 'FRED_API_KEY'],
  ])('names the missing %s environment variable', (provider, variable) => {
    expect(() => requireProviderKey(provider)).toThrow(`${variable} not configured`);
  });
});

describe('clearKey', () => {
  it('removes the override and falls back to env', async () => {
    process.env.FMP_API_KEY = 'env-value';
    await setKey('fmp', 'settings-value');
    keyRepo.remove.mockResolvedValueOnce(true);

    const removed = await clearKey('fmp');

    expect(removed).toBe(true);
    expect(keyRepo.remove).toHaveBeenCalledWith('fmp');
    expect(providerKey('fmp')).toBe('env-value'); // env fallback after clear
    expect(keySource('fmp')).toBe('env');
  });
});

describe('hydrate', () => {
  it('loads persisted overrides into the in-memory map', async () => {
    keyRepo.listAll.mockResolvedValueOnce([{ provider: 'alpha_vantage', api_key: 'persisted-av-key' }]);
    const count = await hydrate();
    expect(count).toBe(1);
    expect(providerKey('alpha_vantage')).toBe('persisted-av-key');
    expect(keySource('alpha_vantage')).toBe('settings');
  });
});
