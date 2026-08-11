import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';
vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

import { query } from '../src/database/connection.js';
import {
  toNumber,
  isValidPrice,
  toDateOnly,
  dateOnlyToTimestampMs,
  normalizeHistoryPoints,
  filterPointsByRange,
  needsHistoryRefresh,
  countChangedPointPrices,
  cacheGet,
  cacheSet,
  resetPriceCache,
  sweepExpiredCacheEntries,
  loadHistoricalPointsFromDatabase,
  saveHistoricalPointsToDatabase,
  loadLatestHistoricalPointByInvestmentIds,
  PRICE_CACHE_TTL_MS,
} from '../src/services/prices/priceCache.js';
import { ValidationError } from '../src/middleware/errorHandler.js';

beforeEach(() => {
  vi.clearAllMocks();
  resetPriceCache();
});

afterEach(() => vi.useRealTimers());

describe('toNumber', () => {
  it('returns finite numbers as-is', () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber(-3.14)).toBe(-3.14);
  });

  it('converts numeric strings', () => {
    expect(toNumber('17.5')).toBe(17.5);
  });

  it('returns undefined for non-numeric input', () => {
    expect(toNumber('abc')).toBeUndefined();
    expect(toNumber(undefined)).toBeUndefined();
    expect(toNumber(NaN)).toBeUndefined();
    expect(toNumber(Infinity)).toBeUndefined();
  });

  it('coerces null and "" to 0 (Number() behavior)', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber('')).toBe(0);
  });
});

describe('isValidPrice', () => {
  it('accepts positive numbers', () => {
    expect(isValidPrice(0.01)).toBe(true);
    expect(isValidPrice(1000)).toBe(true);
    expect(isValidPrice('25.5')).toBe(true);
  });

  it('rejects zero, negative, or non-numeric', () => {
    expect(isValidPrice(0)).toBe(false);
    expect(isValidPrice(-5)).toBe(false);
    expect(isValidPrice(null)).toBe(false);
    expect(isValidPrice('zero')).toBe(false);
  });
});

describe('toDateOnly', () => {
  it('formats epoch ms to YYYY-MM-DD', () => {
    expect(toDateOnly(Date.UTC(2025, 3, 15))).toBe('2025-04-15');
  });

  it('returns undefined for non-finite input', () => {
    expect(toDateOnly(NaN)).toBeUndefined();
    expect(toDateOnly(undefined)).toBeUndefined();
  });
});

describe('dateOnlyToTimestampMs', () => {
  it('returns UTC noon timestamp for valid date string', () => {
    expect(dateOnlyToTimestampMs('2025-04-15')).toBe(Date.UTC(2025, 3, 15, 12, 0, 0, 0));
  });

  it('returns NaN for malformed input', () => {
    expect(dateOnlyToTimestampMs(null)).toBeNaN();
    expect(dateOnlyToTimestampMs('not-a-date')).toBeNaN();
    expect(dateOnlyToTimestampMs('')).toBeNaN();
  });

  it('accepts a pg-read DATE (local-midnight Date object) — the DB cache read shape', () => {
    // String(pgDate) is "Wed Jul 01 2026 …" — the old split('-') path NaN'd on
    // it, so EVERY DB-cached price-history read returned [] (silent live
    // re-fetch / empty chart under db_only), in every deployment.
    expect(dateOnlyToTimestampMs(new Date(2025, 3, 15))).toBe(Date.UTC(2025, 3, 15, 12, 0, 0, 0));
    expect(dateOnlyToTimestampMs(new Date(NaN))).toBeNaN();
  });
});

describe('normalizeHistoryPoints', () => {
  it('returns empty array for non-array input', () => {
    expect(normalizeHistoryPoints(null)).toEqual([]);
    expect(normalizeHistoryPoints(undefined)).toEqual([]);
    expect(normalizeHistoryPoints({})).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeHistoryPoints([])).toEqual([]);
  });

  it('drops invalid timestamps and prices', () => {
    const r = normalizeHistoryPoints([
      { timestampMs: Date.UTC(2025, 3, 1), price: 100 },
      { timestampMs: 'invalid', price: 50 },
      { timestampMs: Date.UTC(2025, 3, 2), price: -10 }, // invalid price
      { timestampMs: Date.UTC(2025, 3, 3), price: 0 }, // zero is invalid
    ]);
    expect(r).toHaveLength(1);
  });

  it('deduplicates by date (last wins)', () => {
    const r = normalizeHistoryPoints([
      { timestampMs: Date.UTC(2025, 3, 1, 5), price: 100 },
      { timestampMs: Date.UTC(2025, 3, 1, 18), price: 110 }, // same date
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].price).toBe(110);
  });

  it('sorts result by date ascending', () => {
    const r = normalizeHistoryPoints([
      { timestampMs: Date.UTC(2025, 3, 5), price: 105 },
      { timestampMs: Date.UTC(2025, 3, 1), price: 100 },
      { timestampMs: Date.UTC(2025, 3, 3), price: 103 },
    ]);
    expect(r.map((p) => p.price)).toEqual([100, 103, 105]);
  });
});

describe('filterPointsByRange', () => {
  const points = [
    { timestampMs: 1000, price: 1 },
    { timestampMs: 2000, price: 2 },
    { timestampMs: 3000, price: 3 },
  ];

  it('returns all points when no range given', () => {
    expect(filterPointsByRange(points)).toEqual(points);
  });

  it('respects fromMs (inclusive)', () => {
    expect(filterPointsByRange(points, { fromMs: 2000 })).toHaveLength(2);
  });

  it('respects toMs (inclusive)', () => {
    expect(filterPointsByRange(points, { toMs: 2000 })).toHaveLength(2);
  });

  it('handles non-array input', () => {
    expect(filterPointsByRange(null)).toEqual([]);
    expect(filterPointsByRange(undefined)).toEqual([]);
  });

  it('ignores non-numeric range bounds', () => {
    expect(filterPointsByRange(points, { fromMs: 'bad', toMs: 'worse' })).toEqual(points);
  });
});

describe('needsHistoryRefresh', () => {
  const FROM = Date.UTC(2025, 0, 1, 12);
  const TO = Date.UTC(2025, 11, 31, 12);

  it('returns true when no points exist', () => {
    expect(needsHistoryRefresh([])).toBe(true);
    expect(needsHistoryRefresh(null)).toBe(true);
  });

  it('returns false when points fully cover the requested range', () => {
    const points = [
      { timestampMs: FROM, price: 100 },
      { timestampMs: TO, price: 110 },
    ];
    expect(needsHistoryRefresh(points, { fromMs: FROM, toMs: TO })).toBe(false);
  });

  it('returns true when first point is too late', () => {
    const points = [{ timestampMs: Date.UTC(2025, 5, 1, 12), price: 100 }];
    expect(needsHistoryRefresh(points, { fromMs: FROM })).toBe(true);
  });

  it('returns true when last point is too early', () => {
    const points = [{ timestampMs: Date.UTC(2025, 5, 1, 12), price: 100 }];
    expect(needsHistoryRefresh(points, { toMs: TO })).toBe(true);
  });
});

describe('countChangedPointPrices', () => {
  it('returns zero for arrays of equal contents', () => {
    const points = [{ price: 100 }, { price: 110 }];
    expect(countChangedPointPrices(points, points)).toBe(0);
  });

  it('counts only meaningful changes', () => {
    const before = [{ price: 100 }, { price: 110 }, { price: 120 }];
    const after = [{ price: 100 }, { price: 115 }, { price: 120 }];
    expect(countChangedPointPrices(before, after)).toBe(1);
  });

  it('ignores invalid entries', () => {
    const before = [{ price: 100 }, { price: null }];
    const after = [{ price: 105 }, { price: 200 }];
    expect(countChangedPointPrices(before, after)).toBe(1);
  });

  it('compares only the overlapping prefix', () => {
    expect(countChangedPointPrices([{ price: 1 }], [{ price: 1 }, { price: 999 }])).toBe(0);
  });

  it('returns 0 for non-array inputs', () => {
    expect(countChangedPointPrices(null, [])).toBe(0);
  });
});

describe('cacheGet / cacheSet / resetPriceCache', () => {
  afterEach(() => resetPriceCache());

  it('round-trips fresh entries', () => {
    cacheSet('k', { foo: 1 });
    expect(cacheGet('k')).toEqual({ foo: 1 });
  });

  it('returns undefined for missing keys', () => {
    expect(cacheGet('missing')).toBeUndefined();
  });

  it('expires entries past TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    cacheSet('k', 'v');

    vi.setSystemTime(PRICE_CACHE_TTL_MS - 1);
    expect(cacheGet('k')).toBe('v');

    vi.setSystemTime(PRICE_CACHE_TTL_MS + 1);
    expect(cacheGet('k')).toBeUndefined();
  });

  it('reset clears all entries', () => {
    cacheSet('a', 1);
    cacheSet('b', 2);
    resetPriceCache();
    expect(cacheGet('a')).toBeUndefined();
    expect(cacheGet('b')).toBeUndefined();
  });
});

describe('sweepExpiredCacheEntries', () => {
  it('removes expired entries and returns the count removed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    cacheSet('a', 1);
    cacheSet('b', 2);

    vi.setSystemTime(PRICE_CACHE_TTL_MS + 1);
    expect(sweepExpiredCacheEntries(Date.now())).toBe(2);
    expect(cacheGet('a')).toBeUndefined();
  });

  it('returns 0 when nothing is expired', () => {
    cacheSet('a', 1);
    expect(sweepExpiredCacheEntries(Date.now())).toBe(0);
  });
});

describe('loadHistoricalPointsFromDatabase', () => {
  it('returns empty when investmentId is not numeric', async () => {
    expect(await loadHistoricalPointsFromDatabase('abc')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('binds null date params when range is missing', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await loadHistoricalPointsFromDatabase(1);
    expect(query.mock.calls[0][1]).toEqual([1, null, null]);
  });

  it('binds date strings when range provided', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await loadHistoricalPointsFromDatabase(1, { fromMs: Date.UTC(2025, 0, 1), toMs: Date.UTC(2025, 11, 31) });
    expect(query.mock.calls[0][1][1]).toBe('2025-01-01');
    expect(query.mock.calls[0][1][2]).toBe('2025-12-31');
  });

  it('normalizes rows from query result', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { price_date: '2025-04-02', close_price: 110 },
        { price_date: '2025-04-01', close_price: 100 },
      ],
    });
    const r = await loadHistoricalPointsFromDatabase(1);
    expect(r.map((p) => p.price)).toEqual([100, 110]);
  });

  it('returns [] when table missing (42P01)', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    expect(await loadHistoricalPointsFromDatabase(1)).toEqual([]);
  });

  it('rethrows unexpected errors', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    await expect(loadHistoricalPointsFromDatabase(1)).rejects.toThrow('boom');
  });
});

describe('saveHistoricalPointsToDatabase', () => {
  it('does nothing when investmentId is not numeric', async () => {
    await saveHistoricalPointsToDatabase('x', [{ timestampMs: Date.UTC(2025, 0, 1), price: 1 }], 'src');
    expect(query).not.toHaveBeenCalled();
  });

  it('does nothing when no valid points', async () => {
    await saveHistoricalPointsToDatabase(1, [], 'src');
    expect(query).not.toHaveBeenCalled();
  });

  it('upserts the points with INSERT … ON CONFLICT', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await saveHistoricalPointsToDatabase(
      1,
      [{ timestampMs: Date.UTC(2025, 3, 1), price: 100 }, { timestampMs: Date.UTC(2025, 3, 2), price: 110 }],
      'binance',
    );
    const [sql, args] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (investment_id, price_date)');
    expect(args[0]).toBe(1);
    expect(args[1]).toBe('binance');
    expect(args[2]).toEqual(['2025-04-01', '2025-04-02']);
    expect(args[3]).toEqual([100, 110]);
  });

  it('defaults source to "provider"', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await saveHistoricalPointsToDatabase(1, [{ timestampMs: Date.UTC(2025, 0, 1), price: 100 }]);
    expect(query.mock.calls[0][1][1]).toBe('provider');
  });

  it('swallows undefined-relation error (42P01)', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('rel'), { code: '42P01' }));
    await expect(saveHistoricalPointsToDatabase(1, [{ timestampMs: Date.UTC(2025, 0, 1), price: 100 }], 's')).resolves.toBeUndefined();
  });

  it('annotates FK-violation errors with context and rethrows', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: '23503' }));
    await expect(
      saveHistoricalPointsToDatabase(1, [{ timestampMs: Date.UTC(2025, 0, 1), price: 100 }], 's'),
    ).rejects.toMatchObject({ code: '23503', context: expect.stringContaining('orphan') });
  });

  it('rethrows other DB errors', async () => {
    query.mockRejectedValueOnce(new Error('something else'));
    await expect(
      saveHistoricalPointsToDatabase(1, [{ timestampMs: Date.UTC(2025, 0, 1), price: 100 }], 's'),
    ).rejects.toThrow('something else');
  });
});

describe('loadLatestHistoricalPointByInvestmentIds', () => {
  it('binds a deduped id list and maps rows by investment', async () => {
    query.mockResolvedValueOnce({
      rows: [{ investment_id: 7, price_date: '2026-01-02', close_price: '12.5' }],
    });

    const byId = await loadLatestHistoricalPointByInvestmentIds([7, 7, 9]);

    expect(query.mock.calls[0][1]).toEqual([[7, 9]]);
    expect(byId.get(7)).toMatchObject({ price: 12.5 });
  });

  it('returns an empty map without querying for an absent or empty list', async () => {
    expect((await loadLatestHistoricalPointByInvestmentIds([])).size).toBe(0);
    expect((await loadLatestHistoricalPointByInvestmentIds(undefined)).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  // Was `.map(Number).filter(Number.isFinite)`, which both dropped and
  // mis-accepted. The only caller passes `inv.id` off investment rows, so a
  // malformed id here means a real bug rather than bad user input — but a
  // dropped id silently returned no fallback price for that investment, which
  // surfaces as an unpriced holding in a valuation rather than as an error.
  // Number.isFinite also let 1.5 through to the `::int[]` cast below.
  it('rejects a malformed id instead of dropping it or passing a float to the int cast', async () => {
    for (const ids of [[7, 'evil'], [1.5], [0], [-1], ['1e3'], [null]]) {
      await expect(
        loadLatestHistoricalPointByInvestmentIds(ids),
        `expected ${JSON.stringify(ids)} to be rejected`,
      ).rejects.toThrow(ValidationError);
    }
    expect(query).not.toHaveBeenCalled();
  });
});
