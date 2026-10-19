import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockConnection } from './helpers/repoMocks.ts';

vi.mock('../src/database/connection.ts', () => mockConnection());

import { query as rawQuery } from '../src/database/connection.ts';
import type { PgQueryResult } from '../src/database/connection.ts';
import mcRepo, { get as mcGet, isFresh as mcIsFresh, upsert as mcUpsert, getActiveUserIds } from '../src/repositories/cashflowForecastMcRepository.ts';
import rollingRepo, { get as rollingGet, isFresh as rollingIsFresh, upsert as rollingUpsert } from '../src/repositories/cashflowForecastMcRollingRepository.ts';
import accuracyRepo from '../src/repositories/cashflowForecastAccuracyRepository.ts';
import providerHealthRepo from '../src/repositories/providerHealthRepository.ts';
import { partial } from './helpers/partial.ts';
import { providerHealthDbRow } from './helpers/portfolioPgRows.ts';

const query = vi.mocked(rawQuery);

beforeEach(() => vi.clearAllMocks());

describe('cashflowForecastMcRepository.get', () => {
  it('returns the row when present', async () => {
    const row = { payload: { foo: 1 }, computed_at: new Date('2025-01-01T00:00:00Z') };
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [row] }));
    const r = await mcGet({ userId: 'u1', month: '2025-04', filterHash: 'abc' });
    expect(r).toEqual(row);
  });

  it('returns null when no row found', async () => {
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [] }));
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

describe('cashflowForecastMcRepository.getActiveUserIds', () => {
  it('returns distinct user ids and always includes anonymous', async () => {
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [{ user_id: 'alice' }, { user_id: 'bob' }] }));
    const ids = await getActiveUserIds();
    expect(ids).toContain('alice');
    expect(ids).toContain('bob');
    expect(ids).toContain('anonymous');
  });

  it('fails closed when daily refresh requires complete user discovery', async () => {
    query.mockRejectedValueOnce(new Error('user discovery unavailable'));
    await expect(getActiveUserIds({ strict: true })).rejects.toThrow('user discovery unavailable');
  });

  it('does not duplicate anonymous if already in result', async () => {
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [{ user_id: 'anonymous' }] }));
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
  it('returns null on miss', async () => {
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [] }));
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
  it('default export wires public functions', () => {
    expect(rollingRepo.get).toBe(rollingGet);
    expect(rollingRepo.upsert).toBe(rollingUpsert);
  });
});

describe('cashflowForecastAccuracyRepository.getHistory', () => {
  it('returns rows from the result', async () => {
    const rows = [
      {
        user_id: 'u',
        method_id: 'naive',
        as_of_month: '2026-05',
        mae: 1,
        rmse: 1.5,
        mape: null,
        sample_days: 31,
        recorded_at: new Date('2026-06-01T00:00:00Z'),
      },
    ];
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows }));
    expect(await accuracyRepo.getHistory({ userId: 'u', methodId: 'm' })).toEqual(rows);
  });
});

describe('providerHealthRepository.listAll', () => {
  it('returns rows from query', async () => {
    const rows = [providerHealthDbRow({ provider: 'binance', kind: 'price' })];
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows }));
    expect(await providerHealthRepo.listAll()).toEqual(rows);
  });
});

describe('providerHealthRepository.findByProvider', () => {
  it('returns null when not found', async () => {
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [] }));
    expect(await providerHealthRepo.findByProvider('unknown')).toBeNull();
  });

  it('returns the matching row', async () => {
    const row = providerHealthDbRow({ provider: 'binance' });
    query.mockResolvedValueOnce(partial<PgQueryResult>({ rows: [row] }));
    expect(await providerHealthRepo.findByProvider('binance')).toBe(row);
  });
});
