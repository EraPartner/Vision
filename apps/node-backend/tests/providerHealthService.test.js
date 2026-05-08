import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../src/repositories/providerHealthRepository.js', () => ({
  default: {
    recordSuccess: vi.fn(),
    recordError: vi.fn(),
    listAll: vi.fn(),
    findByProvider: vi.fn(),
  },
}));

import { logger } from '../src/config/logger.js';
import providerHealthRepository from '../src/repositories/providerHealthRepository.js';
import {
  recordSuccess,
  recordError,
  listProviderHealth,
  probeProvider,
  PROVIDER_DEFINITIONS,
} from '../src/services/providerHealthService.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PROVIDER_DEFINITIONS', () => {
  it('exposes the canonical provider keys', () => {
    expect(Object.keys(PROVIDER_DEFINITIONS).sort()).toEqual(
      ['binance', 'ecb', 'eurostat', 'kinesis', 'open.er-api', 'statbel', 'yahoo'].sort(),
    );
  });

  it('tags each provider with a kind and label', () => {
    for (const [, def] of Object.entries(PROVIDER_DEFINITIONS)) {
      expect(def.kind).toMatch(/^(price|fx|inflation)$/);
      expect(def.label).toBeTruthy();
      expect(typeof def.probe).toBe('function');
    }
  });
});

describe('recordSuccess', () => {
  it('forwards provider+kind to the repository', async () => {
    providerHealthRepository.recordSuccess.mockResolvedValueOnce(undefined);
    await recordSuccess('binance');
    expect(providerHealthRepository.recordSuccess).toHaveBeenCalledWith('binance', 'price');
  });

  it('is a no-op for unknown providers', async () => {
    await recordSuccess('mystery');
    expect(providerHealthRepository.recordSuccess).not.toHaveBeenCalled();
  });

  it('swallows repository errors and logs at debug', async () => {
    providerHealthRepository.recordSuccess.mockRejectedValueOnce(new Error('db down'));
    await expect(recordSuccess('yahoo')).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      'Failed to record provider success',
      expect.objectContaining({ provider: 'yahoo', error: 'db down' }),
    );
  });
});

describe('recordError', () => {
  it('captures Error.message', async () => {
    providerHealthRepository.recordError.mockResolvedValueOnce(undefined);
    await recordError('ecb', new Error('boom'));
    expect(providerHealthRepository.recordError).toHaveBeenCalledWith('ecb', 'fx', 'boom');
  });

  it('coerces non-Error values to string', async () => {
    providerHealthRepository.recordError.mockResolvedValueOnce(undefined);
    await recordError('ecb', 'string error');
    expect(providerHealthRepository.recordError).toHaveBeenCalledWith('ecb', 'fx', 'string error');
  });

  it('is a no-op for unknown providers', async () => {
    await recordError('nope', new Error('x'));
    expect(providerHealthRepository.recordError).not.toHaveBeenCalled();
  });

  it('swallows repository errors', async () => {
    providerHealthRepository.recordError.mockRejectedValueOnce(new Error('db'));
    await expect(recordError('binance', new Error('x'))).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalled();
  });
});

describe('listProviderHealth', () => {
  it('merges stored rows with provider definitions', async () => {
    providerHealthRepository.listAll.mockResolvedValueOnce([
      { provider: 'binance', last_success_at: '2025-04-01', last_error_at: null, last_error: null, consecutive_failures: 0, updated_at: '2025-04-01' },
    ]);
    const list = await listProviderHealth();
    const binance = list.find((p) => p.provider === 'binance');
    expect(binance).toMatchObject({
      provider: 'binance',
      label: 'Binance',
      kind: 'price',
      last_success_at: '2025-04-01',
      consecutive_failures: 0,
    });
  });

  it('returns null timestamps for providers with no stored row', async () => {
    providerHealthRepository.listAll.mockResolvedValueOnce([]);
    const list = await listProviderHealth();
    expect(list).toHaveLength(Object.keys(PROVIDER_DEFINITIONS).length);
    expect(list.every((p) => p.last_success_at === null && p.consecutive_failures === 0)).toBe(true);
  });
});

describe('probeProvider', () => {
  it('throws 404-tagged error for unknown provider', async () => {
    await expect(probeProvider('mystery')).rejects.toMatchObject({
      message: expect.stringContaining('Unknown provider'),
      status: 404,
    });
  });

  it('records success and returns enriched provider on healthy probe', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    providerHealthRepository.recordSuccess.mockResolvedValueOnce(undefined);
    providerHealthRepository.findByProvider.mockResolvedValueOnce({
      last_success_at: '2025-04-02',
      last_error_at: null,
      last_error: null,
      consecutive_failures: 0,
      updated_at: '2025-04-02',
    });

    const result = await probeProvider('binance');

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(providerHealthRepository.recordSuccess).toHaveBeenCalledWith('binance', 'price');
    expect(result.provider).toMatchObject({ provider: 'binance', label: 'Binance', kind: 'price' });
    expect(logger.info).toHaveBeenCalledWith('Provider probe succeeded', { provider: 'binance' });
  });

  it('records error and returns ok=false when probe fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    providerHealthRepository.recordError.mockResolvedValueOnce(undefined);
    providerHealthRepository.findByProvider.mockResolvedValueOnce({
      last_success_at: null,
      last_error_at: '2025-04-02',
      last_error: 'HTTP 503',
      consecutive_failures: 1,
      updated_at: '2025-04-02',
    });

    const result = await probeProvider('ecb');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 503');
    expect(providerHealthRepository.recordError).toHaveBeenCalledWith('ecb', 'fx', 'HTTP 503');
    expect(logger.warn).toHaveBeenCalledWith('Provider probe failed', { provider: 'ecb', error: 'HTTP 503' });
  });

  it('returns ok=false when probe throws non-HTTP error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    vi.stubGlobal('fetch', fetchMock);
    providerHealthRepository.recordError.mockResolvedValueOnce(undefined);
    providerHealthRepository.findByProvider.mockResolvedValueOnce(null);

    const result = await probeProvider('open.er-api');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ENOTFOUND');
    expect(result.provider.consecutive_failures).toBe(0); // null row → fallback default
  });

  it('records an error envelope when kinesis probe URL fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND')));
    providerHealthRepository.recordError.mockResolvedValueOnce(undefined);
    providerHealthRepository.findByProvider.mockResolvedValueOnce(null);

    const result = await probeProvider('kinesis');
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(providerHealthRepository.recordError).toHaveBeenCalledWith('kinesis', 'price', expect.any(String));
  });
});
