import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { query, withTransaction } from '../src/database/connection.js';
import {
  normalizeDateInput,
  fetchFromEcb,
  fetchFromErApi,
  fetchHistoricalFromEcb90d,
  clearHistoricalCache,
  loadFromDatabase,
  saveToDatabase,
  saveHistoricalRate,
  getNearestRateFromDatabase,
  buildHistoricalRateIndex,
  findNearestRateInIndex,
  getRateToEurForDate,
} from '../src/services/currency/rateFetcher.js';

beforeEach(() => {
  vi.clearAllMocks();
  clearHistoricalCache();
  let mockClient = { query: vi.fn().mockResolvedValue({ rows: [] }) };
  withTransaction.mockImplementation(async (fn) => fn(mockClient));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeDateInput', () => {
  it('extracts YYYY-MM-DD prefix from ISO timestamps', () => {
    expect(normalizeDateInput('2025-04-15T10:00:00Z')).toBe('2025-04-15');
    expect(normalizeDateInput('2025-04-15')).toBe('2025-04-15');
  });

  it('returns null for malformed/empty input', () => {
    expect(normalizeDateInput(null)).toBeNull();
    expect(normalizeDateInput('')).toBeNull();
    expect(normalizeDateInput('not-a-date')).toBeNull();
  });
});

describe('fetchFromEcb', () => {
  it('parses ECB XML into X→EUR rate map', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <Cube currency="USD" rate="1.10"/>
        <Cube currency="GBP" rate="0.85"/>
      `,
    }));

    const r = await fetchFromEcb();
    expect(r.EUR).toBe(1);
    expect(r.USD).toBeCloseTo(1 / 1.10, 4);
    expect(r.GBP).toBeCloseTo(1 / 0.85, 4);
  });

  it('returns null on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    expect(await fetchFromEcb()).toBeNull();
  });

  it('returns null on fetch throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await fetchFromEcb()).toBeNull();
  });

  it('returns null when XML has no Cube elements', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<empty/>' }));
    expect(await fetchFromEcb()).toBeNull();
  });

  it('rejects out-of-range rates (clamp <0.0001 or >100000)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <Cube currency="USD" rate="1.0"/>
        <Cube currency="ZZZ" rate="0.00001"/>
        <Cube currency="QQQ" rate="9999999"/>
      `,
    }));
    const r = await fetchFromEcb();
    expect(r.USD).toBe(1);
    expect(r.ZZZ).toBeUndefined();
    expect(r.QQQ).toBeUndefined();
  });
});

describe('fetchFromErApi', () => {
  it('parses successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'success', rates: { USD: 1.10, GBP: 0.85 } }),
    }));
    const r = await fetchFromErApi();
    expect(r.USD).toBeCloseTo(1 / 1.10, 4);
    expect(r.EUR).toBe(1);
  });

  it('returns null on non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    expect(await fetchFromErApi()).toBeNull();
  });

  it('returns null when result.result !== success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 'error' }),
    }));
    expect(await fetchFromErApi()).toBeNull();
  });

  it('returns null on fetch throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));
    expect(await fetchFromErApi()).toBeNull();
  });
});

describe('fetchHistoricalFromEcb90d', () => {
  it('returns Map indexed by date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <Cube time="2025-04-15">
          <Cube currency="USD" rate="1.10"/>
        </Cube>
        <Cube time="2025-04-16">
          <Cube currency="USD" rate="1.11"/>
        </Cube>
      `,
    }));
    const r = await fetchHistoricalFromEcb90d();
    expect(r.get('2025-04-15').USD).toBeCloseTo(1 / 1.10, 4);
    expect(r.get('2025-04-16').USD).toBeCloseTo(1 / 1.11, 4);
  });

  it('returns empty Map on error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    expect(await fetchHistoricalFromEcb90d()).toBeInstanceOf(Map);
  });

  it('caches the result for 24 hours', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<Cube time="2025-04-15"><Cube currency="USD" rate="1.10"/></Cube>',
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchHistoricalFromEcb90d();
    await fetchHistoricalFromEcb90d();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('loadFromDatabase', () => {
  it('returns null when DB has no rows', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await loadFromDatabase()).toBeNull();
  });

  it('builds rate map from rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ currency_code: 'USD', rate_to_eur: '0.91' }] });
    const r = await loadFromDatabase();
    expect(r.EUR).toBe(1);
    expect(r.USD).toBeCloseTo(0.91, 4);
  });

  it('returns null and logs on query error', async () => {
    query.mockRejectedValueOnce(new Error('timeout'));
    expect(await loadFromDatabase()).toBeNull();
  });
});

describe('saveToDatabase', () => {
  it('does nothing when only EUR is present', async () => {
    await saveToDatabase({ EUR: 1 });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('clears prior latest markers and upserts new entries', async () => {
    let mockClient;
    withTransaction.mockImplementationOnce(async (fn) => {
      mockClient = { query: vi.fn().mockResolvedValue({ rows: [] }) };
      await fn(mockClient);
    });
    await saveToDatabase({ EUR: 1, USD: 0.91, GBP: 1.18 });
    expect(mockClient.query).toHaveBeenCalledTimes(3); // 1 update + 2 upserts
    const updateCall = mockClient.query.mock.calls[0];
    expect(updateCall[0]).toContain('UPDATE exchange_rates');
    expect(updateCall[1][0]).toEqual(['USD', 'GBP']);
  });

  it('swallows errors and logs', async () => {
    withTransaction.mockRejectedValueOnce(new Error('db down'));
    await expect(saveToDatabase({ EUR: 1, USD: 0.91 })).resolves.toBeUndefined();
  });
});

describe('saveHistoricalRate', () => {
  it('upserts a non-latest rate row', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await saveHistoricalRate('USD', '2024-12-31', 0.9);
    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain('is_latest');
    expect(sql).toContain('ON CONFLICT (currency_code, rate_date)');
    expect(args).toEqual(['USD', 0.9, '2024-12-31']);
  });
});

describe('getNearestRateFromDatabase', () => {
  it('returns undefined when no rows match', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getNearestRateFromDatabase('USD', '2025-04-01')).toBeUndefined();
  });

  it('returns the rate from the nearest stored row', async () => {
    query.mockResolvedValueOnce({ rows: [{ rate_to_eur: '0.92' }] });
    expect(await getNearestRateFromDatabase('USD', '2025-04-01')).toBeCloseTo(0.92, 4);
  });
});

describe('buildHistoricalRateIndex', () => {
  it('groups rows by uppercase currency code, sorted by date asc', () => {
    const idx = buildHistoricalRateIndex([
      { currency_code: 'usd', rate_date: '2025-04-02', rate_to_eur: '0.92' },
      { currency_code: 'USD', rate_date: '2025-04-01', rate_to_eur: '0.91' },
      { currency_code: 'gbp', rate_date: '2025-04-01', rate_to_eur: '1.18' },
    ]);
    expect(idx.get('USD')).toHaveLength(2);
    expect(idx.get('USD')[0].date).toBe('2025-04-01');
    expect(idx.get('GBP')).toHaveLength(1);
  });

  it('drops rows with invalid date or rate', () => {
    const idx = buildHistoricalRateIndex([
      { currency_code: 'USD', rate_date: 'garbage', rate_to_eur: 1 },
      { currency_code: '', rate_date: '2025-04-01', rate_to_eur: 1 },
      { currency_code: 'USD', rate_date: '2025-04-01', rate_to_eur: NaN },
      { currency_code: 'USD', rate_date: '2025-04-01', rate_to_eur: '0.9' },
    ]);
    expect(idx.get('USD')).toHaveLength(1);
  });
});

describe('findNearestRateInIndex', () => {
  const idx = buildHistoricalRateIndex([
    { currency_code: 'USD', rate_date: '2025-01-01', rate_to_eur: '1.0' },
    { currency_code: 'USD', rate_date: '2025-04-01', rate_to_eur: '0.9' },
    { currency_code: 'USD', rate_date: '2025-12-31', rate_to_eur: '0.95' },
  ]);

  it('returns 1 for EUR', () => {
    expect(findNearestRateInIndex(idx, 'EUR', '2025-04-01')).toBe(1);
  });

  it('returns undefined for unknown currency', () => {
    expect(findNearestRateInIndex(idx, 'JPY', '2025-04-01')).toBeUndefined();
  });

  it('returns exact match when present', () => {
    expect(findNearestRateInIndex(idx, 'USD', '2025-04-01')).toBeCloseTo(0.9, 4);
  });

  it('returns the closer of two surrounding dates', () => {
    expect(findNearestRateInIndex(idx, 'USD', '2025-02-01')).toBeCloseTo(1.0, 4); // closer to Jan 1
    expect(findNearestRateInIndex(idx, 'USD', '2025-06-01')).toBeCloseTo(0.9, 4); // closer to Apr 1
  });

  it('returns boundary entry when date is outside the index range', () => {
    expect(findNearestRateInIndex(idx, 'USD', '2024-01-01')).toBeCloseTo(1.0, 4);
    expect(findNearestRateInIndex(idx, 'USD', '2030-01-01')).toBeCloseTo(0.95, 4);
  });
});

describe('getRateToEurForDate', () => {
  it('returns 1 for EUR or null currency', async () => {
    expect(await getRateToEurForDate('EUR', '2025-04-01')).toBe(1);
    expect(await getRateToEurForDate(null, '2025-04-01')).toBe(1);
  });

  it('returns undefined when date is malformed', async () => {
    expect(await getRateToEurForDate('USD', 'invalid')).toBeUndefined();
  });

  it('returns exact-match rate from DB if present', async () => {
    query.mockResolvedValueOnce({ rows: [{ rate_to_eur: '0.92' }] });
    expect(await getRateToEurForDate('USD', '2025-04-01')).toBeCloseTo(0.92, 4);
  });

  it('falls back to ECB historical map when DB lacks exact match', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // no exact match in DB
    query.mockResolvedValueOnce({ rows: [] }); // saveHistoricalRate
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<Cube time="2025-04-01"><Cube currency="USD" rate="1.10"/></Cube>',
    }));

    const r = await getRateToEurForDate('USD', '2025-04-01');
    expect(r).toBeCloseTo(1 / 1.10, 4);
    // saveHistoricalRate should have been invoked
    const sqlCalls = query.mock.calls.map((c) => c[0]);
    expect(sqlCalls.some((s) => s.includes('INSERT INTO exchange_rates'))).toBe(true);
  });

  it('skips persistence when saveFetchedHistoricalRate=false', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '<Cube time="2025-04-01"><Cube currency="USD" rate="1.10"/></Cube>',
    }));

    await getRateToEurForDate('USD', '2025-04-01', { saveFetchedHistoricalRate: false });
    const sqlCalls = query.mock.calls.map((c) => c[0]);
    expect(sqlCalls.some((s) => s.includes('INSERT INTO exchange_rates'))).toBe(false);
  });

  it('falls back to nearest DB rate when neither exact nor ECB match found', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // exact
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<empty/>' }));
    query.mockResolvedValueOnce({ rows: [{ rate_to_eur: '0.95' }] }); // nearest

    const r = await getRateToEurForDate('USD', '2025-04-01');
    expect(r).toBeCloseTo(0.95, 4);
  });
});
