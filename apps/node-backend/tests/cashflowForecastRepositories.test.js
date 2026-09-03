import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockConnection } from './helpers/repoMocks.js';

vi.mock('../src/database/connection.js', () => mockConnection());

import { query } from '../src/database/connection.js';
import mcRepo, { get as mcGet, isFresh as mcIsFresh, upsert as mcUpsert, getActiveUserIds } from '../src/repositories/cashflowForecastMcRepository.js';
import rollingRepo, { get as rollingGet, isFresh as rollingIsFresh, upsert as rollingUpsert } from '../src/repositories/cashflowForecastMcRollingRepository.js';
import accuracyRepo from '../src/repositories/cashflowForecastAccuracyRepository.js';
import providerHealthRepo from '../src/repositories/providerHealthRepository.js';

beforeEach(() => vi.clearAllMocks());

describe('cashflowForecastMcRepository.get', () => {
  it('returns the row when present', async () => {
    const row = { payload: { foo: 1 }, computed_at: new Date('2025-01-01T00:00:00Z') };
    query.mockResolvedValueOnce({ rows: [row] });
    const r = await mcGet({ userId: 'u1', month: '2025-04', filterHash: 'abc' });
    expect(r).toEqual(row);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM cashflow_forecast_mc'), ['u1', '2025-04', 'abc']);
  });

  it('returns null when no row found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await mcGet({ userId: 'u', month: 'm', filterHash: 'h' })).toBeNull();
  });
});

describe('cashflowForecastMcRepository.isFresh', () => {
  afterEach(() => vi.useRealTimers());

  it('returns true within 6 hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-04-01T06:00:00Z'));
    expect(mcIsFresh(new Date('2025-04-01T05:00:00Z'))).toBe(true);
  });

  it('returns false past 6 hours', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-04-01T13:00:00Z'));
    expect(mcIsFresh(new Date('2025-04-01T05:00:00Z'))).toBe(false);
  });

  it('accepts ISO strings as input', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-04-01T01:00:00Z'));
    expect(mcIsFresh('2025-04-01T00:00:00Z')).toBe(true);
  });
});

describe('cashflowForecastMcRepository.upsert', () => {
  it('serialises payload to JSON and binds 5 params', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await mcUpsert({ userId: 'u1', month: '2025-04', filterHash: 'h', mcPaths: 1000, payload: { p: 1 } });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO cashflow_forecast_mc');
    expect(sql).toContain('ON CONFLICT (user_id, month, filter_hash)');
    expect(params).toEqual(['u1', '2025-04', 'h', 1000, JSON.stringify({ p: 1 })]);
  });
});

describe('cashflowForecastMcRepository.getActiveUserIds', () => {
  it('returns distinct user ids and always includes anonymous', async () => {
    query.mockResolvedValueOnce({ rows: [{ user_id: 'alice' }, { user_id: 'bob' }] });
    const ids = await getActiveUserIds();
    expect(ids).toContain('alice');
    expect(ids).toContain('bob');
    expect(ids).toContain('anonymous');
  });

  it('does not duplicate anonymous if already in result', async () => {
    query.mockResolvedValueOnce({ rows: [{ user_id: 'anonymous' }] });
    const ids = await getActiveUserIds();
    expect(ids.filter((i) => i === 'anonymous')).toHaveLength(1);
  });

  it('falls back to [anonymous] on query failure', async () => {
    query.mockRejectedValueOnce(new Error('no table'));
    expect(await getActiveUserIds()).toEqual(['anonymous']);
  });

  it('default export wires the public functions', () => {
    expect(mcRepo.get).toBe(mcGet);
    expect(mcRepo.isFresh).toBe(mcIsFresh);
    expect(mcRepo.upsert).toBe(mcUpsert);
    expect(mcRepo.getActiveUserIds).toBe(getActiveUserIds);
  });
});

describe('cashflowForecastMcRollingRepository.get', () => {
  it('binds the 5-key composite lookup', async () => {
    query.mockResolvedValueOnce({ rows: [{ payload: {}, computed_at: new Date() }] });
    await rollingGet({ userId: 'u', todayIso: '2025-04-01', daysBack: 30, daysForward: 60, filterHash: 'h' });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual(['u', '2025-04-01', 30, 60, 'h']);
  });

  it('returns null on miss', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await rollingGet({ userId: 'u', todayIso: 'd', daysBack: 1, daysForward: 1, filterHash: 'h' })).toBeNull();
  });
});

describe('cashflowForecastMcRollingRepository.isFresh', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the same 6-hour TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-04-01T05:59:00Z'));
    expect(rollingIsFresh(new Date('2025-04-01T00:00:00Z'))).toBe(true);
    vi.setSystemTime(new Date('2025-04-01T06:01:00Z'));
    expect(rollingIsFresh(new Date('2025-04-01T00:00:00Z'))).toBe(false);
  });
});

describe('cashflowForecastMcRollingRepository.upsert', () => {
  it('serialises payload and binds 7 params', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await rollingUpsert({
      userId: 'u', todayIso: '2025-04-01', daysBack: 30, daysForward: 60, filterHash: 'h', mcPaths: 500, payload: { x: 1 },
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO cashflow_forecast_mc_rolling');
    expect(params).toEqual(['u', '2025-04-01', 30, 60, 'h', 500, JSON.stringify({ x: 1 })]);
  });

  it('default export wires public functions', () => {
    expect(rollingRepo.get).toBe(rollingGet);
    expect(rollingRepo.upsert).toBe(rollingUpsert);
  });
});

describe('cashflowForecastAccuracyRepository.upsert', () => {
  it('binds 7 params and uses ON CONFLICT idempotency', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await accuracyRepo.upsert({
      userId: 'u', methodId: 'naive', asOfMonth: '2025-04', mae: 10, rmse: 12, mape: 0.05, sampleDays: 30,
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (user_id, method_id, as_of_month)');
    expect(params).toEqual(['u', 'naive', '2025-04', 10, 12, 0.05, 30]);
  });
});

describe('cashflowForecastAccuracyRepository.getHistory', () => {
  it('uses default limitMonths=24 and orders by as_of_month DESC', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await accuracyRepo.getHistory({ userId: 'u', methodId: 'naive' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ORDER BY as_of_month DESC');
    expect(params).toEqual(['u', 'naive', 24]);
  });

  it('passes custom limitMonths', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await accuracyRepo.getHistory({ userId: 'u', methodId: 'm', limitMonths: 6 });
    expect(query.mock.calls[0][1]).toEqual(['u', 'm', 6]);
  });

  it('returns rows from the result', async () => {
    const rows = [{ method_id: 'naive', mae: 1 }];
    query.mockResolvedValueOnce({ rows });
    expect(await accuracyRepo.getHistory({ userId: 'u', methodId: 'm' })).toEqual(rows);
  });
});

describe('cashflowForecastAccuracyRepository.getLatestByMethod', () => {
  it('uses DISTINCT ON to get newest per method', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await accuracyRepo.getLatestByMethod({ userId: 'u' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('DISTINCT ON (method_id)');
    expect(params).toEqual(['u']);
  });
});

describe('cashflowForecastAccuracyRepository.getAllHistory', () => {
  it('uses default limitMonths=24', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await accuracyRepo.getAllHistory({ userId: 'u' });
    expect(query.mock.calls[0][1]).toEqual(['u', 24]);
  });

  it('uses custom limit and orders chronologically', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await accuracyRepo.getAllHistory({ userId: 'u', limitMonths: 12 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('ORDER BY method_id, as_of_month ASC');
    expect(params).toEqual(['u', 12]);
  });
});

describe('providerHealthRepository.listAll', () => {
  it('orders by kind, then provider', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await providerHealthRepo.listAll();
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('ORDER BY kind ASC, provider ASC');
  });

  it('returns rows from query', async () => {
    const rows = [{ provider: 'binance', kind: 'price' }];
    query.mockResolvedValueOnce({ rows });
    expect(await providerHealthRepo.listAll()).toEqual(rows);
  });
});

describe('providerHealthRepository.findByProvider', () => {
  it('returns null when not found', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await providerHealthRepo.findByProvider('unknown')).toBeNull();
  });

  it('returns the matching row', async () => {
    const row = { provider: 'binance' };
    query.mockResolvedValueOnce({ rows: [row] });
    expect(await providerHealthRepo.findByProvider('binance')).toBe(row);
  });

  it('binds provider as the only param', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await providerHealthRepo.findByProvider('ecb');
    expect(query.mock.calls[0][1]).toEqual(['ecb']);
  });
});

describe('providerHealthRepository.recordSuccess', () => {
  it('resets consecutive_failures via UPSERT', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await providerHealthRepo.recordSuccess('binance', 'price');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('consecutive_failures = 0');
    expect(sql).toContain('ON CONFLICT (provider)');
    expect(params).toEqual(['binance', 'price']);
  });
});

describe('providerHealthRepository.recordError', () => {
  it('truncates very long messages to 1000 chars', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const longMsg = 'x'.repeat(2000);
    await providerHealthRepo.recordError('binance', 'price', longMsg);
    const params = query.mock.calls[0][1];
    expect(params[2]).toHaveLength(1000);
  });

  it('coerces non-string error to string', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await providerHealthRepo.recordError('binance', 'price', { code: 500 });
    const params = query.mock.calls[0][1];
    expect(typeof params[2]).toBe('string');
  });

  it('increments consecutive_failures on conflict', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await providerHealthRepo.recordError('binance', 'price', 'fail');
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('consecutive_failures = provider_health.consecutive_failures + 1');
  });
});
