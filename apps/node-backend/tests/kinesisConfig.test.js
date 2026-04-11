import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ENV_KEYS = [
  'KINESIS_BASE_URL',
  'KINESIS_DEFAULT_TIMEFRAME',
  'KINESIS_DEFAULT_FROM_DATE',
];

const originalEnv = process.env;

function clearManagedEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

async function importFresh() {
  vi.resetModules();
  return import('../src/config/kinesisConfig.js');
}

describe('kinesisConfig', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    clearManagedEnv();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses defaults when env vars are absent', async () => {
    const {
      KINESIS_BASE_URL,
      KINESIS_DEFAULT_TIMEFRAME,
      KINESIS_DEFAULT_FROM_DATE,
      getKinesisAssetConfig,
      getAllKinesisAssets,
    } = await importFresh();

    expect(KINESIS_BASE_URL).toBe('https://api.kinesis.money/api/market-data/trendlines');
    expect(KINESIS_DEFAULT_TIMEFRAME).toBe(60);
    expect(KINESIS_DEFAULT_FROM_DATE).toBe('2019-01-01T08:47:55.843Z');

    expect(getKinesisAssetConfig('xau_usd')).toEqual({
      symbol: 'XAU_USD',
      timeframe: 60,
      fromDate: '2019-01-01T08:47:55.843Z',
    });
    expect(getKinesisAssetConfig('unknown_asset')).toBeUndefined();

    const assets = getAllKinesisAssets();
    expect(assets).toHaveProperty('kaufen_gold');
    expect(assets).toHaveProperty('xpd_usd');
    expect(assets).not.toBe(getAllKinesisAssets());
  });

  it('uses env overrides for base url, timeframe and from date', async () => {
    process.env.KINESIS_BASE_URL = 'https://example.test/trendlines';
    process.env.KINESIS_DEFAULT_TIMEFRAME = '30';
    process.env.KINESIS_DEFAULT_FROM_DATE = '2020-01-01T00:00:00.000Z';

    const {
      KINESIS_BASE_URL,
      KINESIS_DEFAULT_TIMEFRAME,
      KINESIS_DEFAULT_FROM_DATE,
    } = await importFresh();

    expect(KINESIS_BASE_URL).toBe('https://example.test/trendlines');
    expect(KINESIS_DEFAULT_TIMEFRAME).toBe(30);
    expect(KINESIS_DEFAULT_FROM_DATE).toBe('2020-01-01T00:00:00.000Z');
  });
});
