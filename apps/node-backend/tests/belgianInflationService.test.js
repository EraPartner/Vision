import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => {
  const queryFn = vi.fn();
  return {
    query: queryFn,
    withTransaction: vi.fn(async (fn) => {
      await queryFn('BEGIN');
      const result = await fn({ query: queryFn });
      await queryFn('COMMIT');
      return result;
    }),
  };
});

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { query } from '../src/database/connection.js';
import { logger } from '../src/config/logger.js';
import {
  clearInflationMemoryCache,
  getInflationRates,
  warmInflationCache,
} from '../src/services/belgianInflationService.js';

describe('belgianInflationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearInflationMemoryCache();
  });

  it('returns cached database rates without external fetch', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ month_date: '2024-01-01', monthly_rate: '0.00400000' }],
      })
      .mockResolvedValueOnce({
        rows: [{ month_date: '2024-01-01', monthly_rate: '0.00400000' }],
      });

    const result = await getInflationRates({ startMonth: '2024-01', endMonth: '2024-12' });

    expect(result.source).toBe('database');
    expect(result.rates).toEqual([{ month: '2024-01', monthly_rate: 0.004 }]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keys a pg-read DATE (Date object) by its LOCAL month, not the UTC-shifted prior month', async () => {
    // node-postgres returns a DATE column as a server-local-midnight Date.
    // First-of-month via UTC extraction rolled back to the prior month on a
    // UTC+ server; local getters must keep 2024-01.
    const pgDate = new Date(2024, 0, 1); // local Jan 1 2024
    query
      .mockResolvedValueOnce({ rows: [{ month_date: pgDate, monthly_rate: '0.00400000' }] })
      .mockResolvedValueOnce({ rows: [{ month_date: pgDate, monthly_rate: '0.00400000' }] });

    const result = await getInflationRates({ startMonth: '2024-01', endMonth: '2024-12' });

    expect(result.source).toBe('database');
    expect(result.rates).toEqual([{ month: '2024-01', monthly_rate: 0.004 }]);
  });

  it('fetches Statbel rates and saves to database when db is empty', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { year: 2024, month: 1, value: '0.30' },
          { year: 2024, month: 2, value: '0.20' },
        ],
      }),
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getInflationRates({ forceRefresh: true });

    expect(result.source).toBe('statbel');
    expect(result.rates).toEqual([
      { month: '2024-01', monthly_rate: 0.003 },
      { month: '2024-02', monthly_rate: 0.002 },
    ]);
    expect(fetchMock).toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith('BEGIN');
    expect(query).toHaveBeenCalledWith('COMMIT');
    vi.unstubAllGlobals();
  });

  it('falls back to database when Statbel fetch fails', async () => {
    // The catch path now reloads the *full* rate set for the memory cache
    // (never a date-range subset), so it issues an extra loadFromDatabase() —
    // a blanket mock keeps the test robust to the exact query count.
    query.mockResolvedValue({
      rows: [{ month_date: '2023-12-01', monthly_rate: '0.00150000' }],
    });

    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getInflationRates({ startMonth: '2023-12', forceRefresh: true });

    expect(result.source).toBe('database');
    expect(result.rates).toEqual([{ month: '2023-12', monthly_rate: 0.0015 }]);
    vi.unstubAllGlobals();
  });

  it('retries Statbel fetch and succeeds on a later attempt', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ year: 2024, month: 1, value: '0.30' }],
        }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getInflationRates({ forceRefresh: true });

    expect(result.source).toBe('statbel');
    expect(result.rates).toEqual([{ month: '2024-01', monthly_rate: 0.003 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('throttles repeated Statbel fallback warnings while offline', async () => {
    vi.useFakeTimers();
    query
      .mockResolvedValue({ rows: [{ month_date: '2023-12-01', monthly_rate: '0.00150000' }] });

    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const first = getInflationRates({ startMonth: '2023-12', forceRefresh: true });
    await vi.runAllTimersAsync();
    await first;

    const second = getInflationRates({ startMonth: '2023-12', forceRefresh: true });
    await vi.runAllTimersAsync();
    await second;

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('falls back to Eurostat when Statbel is unreachable', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('bestat.statbel') || String(url).includes('bestat.economie.fgov')) {
        throw new Error('statbel unreachable');
      }

      return {
        ok: true,
        json: async () => ({
          dimension: {
            time: {
              category: {
                index: {
                  '2024-01': 0,
                  '2024-02': 1,
                  '2024-03': 2,
                },
              },
            },
          },
          value: {
            0: 100,
            1: 100.5,
            2: 101,
          },
        }),
      };
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await getInflationRates({ forceRefresh: true });

    expect(result.source).toBe('eurostat');
    // monthly_rate is now kept to the column's full 8-dp scale (was 6 dp).
    expect(result.rates).toEqual([
      { month: '2024-02', monthly_rate: 0.005 },
      { month: '2024-03', monthly_rate: 0.00497512 },
    ]);
    expect(query).toHaveBeenCalledWith('BEGIN');
    expect(query).toHaveBeenCalledWith('COMMIT');

    vi.unstubAllGlobals();
  });

  it('returns database rates in dbOnly mode and schedules background refresh', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ month_date: '2024-01-01', monthly_rate: '0.00400000' }],
      })
      .mockResolvedValueOnce({
        rows: [{ month_date: '2024-01-01', monthly_rate: '0.00400000' }],
      });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { year: 2024, month: 1, value: '0.30' },
          { year: 2024, month: 2, value: '0.20' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getInflationRates({
      startMonth: '2024-01',
      endMonth: '2024-12',
      dbOnly: true,
      scheduleBackgroundRefresh: true,
    });

    expect(result.source).toBe('database');
    expect(result.rates).toEqual([{ month: '2024-01', monthly_rate: 0.004 }]);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    vi.unstubAllGlobals();
  });

  it('does not use memory shortcut in dbOnly mode when db slice is empty', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ month_date: '2024-01-01', monthly_rate: '0.00400000' }],
      })
      .mockResolvedValueOnce({
        rows: [{ month_date: '2024-01-01', monthly_rate: '0.00400000' }],
      });

    await getInflationRates();

    query.mockResolvedValueOnce({ rows: [] });
    const dbOnlyResult = await getInflationRates({
      startMonth: '2025-01',
      endMonth: '2025-12',
      dbOnly: true,
    });

    expect(dbOnlyResult.source).toBe('database');
    expect(dbOnlyResult.rates).toEqual([]);
  });

  it('saves all fetched rates with a single batched INSERT (no N+1)', async () => {
    // 5 empty pre-checks during the refresh path (db loads + filter checks),
    // then BEGIN, then exactly ONE INSERT for all rates, then COMMIT.
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { year: 2024, month: 1, value: '0.30' },
          { year: 2024, month: 2, value: '0.20' },
          { year: 2024, month: 3, value: '0.10' },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await getInflationRates({ forceRefresh: true });

    const insertCalls = query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO belgian_inflation_rates')
    );
    expect(insertCalls).toHaveLength(1);

    const [sql, params] = insertCalls[0];
    // Three rows × three params per row = 9 params bound to the single query.
    expect(params).toHaveLength(9);
    // VALUES list contains three placeholder groups.
    expect(sql.match(/\$\d+::date/g)).toHaveLength(3);

    vi.unstubAllGlobals();
  });

  it('warmInflationCache returns DB quickly when available and refreshes in background', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ month_date: '2024-01-01', monthly_rate: '0.00400000' }],
      })
      .mockResolvedValueOnce({
        rows: [{ month_date: '2024-01-01', monthly_rate: '0.00400000' }],
      });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ year: 2024, month: 1, value: '0.30' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await warmInflationCache();

    expect(result.source).toBe('database');
    expect(result.rates).toEqual([{ month: '2024-01', monthly_rate: 0.004 }]);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    vi.unstubAllGlobals();
  });
});
