import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import watchlistRepository from '../src/repositories/watchlistRepository.js';

describe('watchlistRepository.buildWhereClause', () => {
  it('returns base WHERE 1=1 with no params when no asset class', () => {
    const { where, params, nextParam } = watchlistRepository.buildWhereClause({});
    expect(where).toBe('WHERE 1=1');
    expect(params).toEqual([]);
    expect(nextParam).toBe(1);
  });

  it('appends asset_class filter when provided', () => {
    const { where, params, nextParam } = watchlistRepository.buildWhereClause({ assetClass: 'stock' });
    expect(where).toBe('WHERE 1=1 AND asset_class = $1');
    expect(params).toEqual(['stock']);
    expect(nextParam).toBe(2);
  });

  it('treats empty options as no filter', () => {
    const { where, params } = watchlistRepository.buildWhereClause();
    expect(where).toBe('WHERE 1=1');
    expect(params).toEqual([]);
  });
});

describe('watchlistRepository.getAll', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses default pagination (limit=50, offset=0) when none given', async () => {
    query.mockResolvedValue({ rows: [] });
    await watchlistRepository.getAll();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('SELECT * FROM watchlist');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual([50, 0]);
  });

  it('passes limit/offset to SQL params', async () => {
    query.mockResolvedValue({ rows: [] });
    await watchlistRepository.getAll({ limit: 10, offset: 20 });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([10, 20]);
  });

  it('appends asset_class filter when provided', async () => {
    query.mockResolvedValue({ rows: [] });
    await watchlistRepository.getAll({ assetClass: 'crypto', limit: 5, offset: 0 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('asset_class = $1');
    expect(params).toEqual(['crypto', 5, 0]);
  });

  it('returns rows from the query result', async () => {
    const rows = [{ id: 1, name: 'Apple', symbol: 'AAPL' }];
    query.mockResolvedValue({ rows });
    expect(await watchlistRepository.getAll()).toEqual(rows);
  });
});

describe('watchlistRepository.getAllWithCount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns total=0 and empty rows when nothing found', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await watchlistRepository.getAllWithCount();
    expect(result).toEqual({ rows: [], total: 0 });
  });

  it('parses total_count from window aggregate and strips it from rows', async () => {
    query.mockResolvedValue({
      rows: [
        { id: 1, name: 'A', total_count: '7' },
        { id: 2, name: 'B', total_count: '7' },
      ],
    });
    const { rows, total } = await watchlistRepository.getAllWithCount();
    expect(total).toBe(7);
    expect(rows).toEqual([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ]);
  });

  it('rewrites bare asset_class column reference to w.asset_class for the join-friendly query', async () => {
    query.mockResolvedValue({ rows: [] });
    await watchlistRepository.getAllWithCount({ assetClass: 'bond' });
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('w.asset_class = $1');
    expect(sql).toContain('COUNT(*) OVER ()');
  });
});

describe('watchlistRepository.getCount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses count from query result as integer', async () => {
    query.mockResolvedValue({ rows: [{ count: '42' }] });
    expect(await watchlistRepository.getCount()).toBe(42);
  });

  it('uses asset_class filter in count query when provided', async () => {
    query.mockResolvedValue({ rows: [{ count: '3' }] });
    await watchlistRepository.getCount({ assetClass: 'etf' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('count(*)');
    expect(sql).toContain('asset_class = $1');
    expect(params).toEqual(['etf']);
  });
});

describe('watchlistRepository.getById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the matching row', async () => {
    query.mockResolvedValue({ rows: [{ id: 5, name: 'X' }] });
    expect(await watchlistRepository.getById(5)).toEqual({ id: 5, name: 'X' });
  });

  it('returns null when no row matches', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await watchlistRepository.getById(999)).toBeNull();
  });
});

describe('watchlistRepository.create', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults currency to EUR and nullifies optional fields', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
    await watchlistRepository.create({ name: 'Tesla', asset_class: 'stock', target_price: 100 });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual(['Tesla', null, 'stock', 100, 'EUR', null, null]);
  });

  it('passes through provided symbol, currency, notes, price_provider_id', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
    await watchlistRepository.create({
      name: 'BTC',
      symbol: 'BTC-EUR',
      asset_class: 'crypto',
      target_price: 50000,
      currency: 'USD',
      notes: 'wait for dip',
      price_provider_id: 7,
    });
    const [, params] = query.mock.calls[0];
    expect(params).toEqual(['BTC', 'BTC-EUR', 'crypto', 50000, 'USD', 'wait for dip', 7]);
  });

  it('returns the inserted row', async () => {
    query.mockResolvedValue({ rows: [{ id: 99, name: 'Z' }] });
    const created = await watchlistRepository.create({ name: 'Z', asset_class: 's', target_price: 1 });
    expect(created).toEqual({ id: 99, name: 'Z' });
  });
});

describe('watchlistRepository.update', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds dynamic SET clause and binds id last', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, name: 'New' }] });
    await watchlistRepository.update(1, { name: 'New', target_price: 5 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('UPDATE watchlist SET');
    expect(sql).toContain('name = $1');
    expect(sql).toContain('target_price = $2');
    expect(sql).toContain('WHERE id = $3');
    expect(params).toEqual(['New', 5, 1]);
  });

  it('ignores fields not in the allowlist', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, name: 'A' }] });
    await watchlistRepository.update(1, { name: 'A', forbidden: 'evil', id: 999 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('forbidden');
    expect(sql).not.toContain('$3 WHERE id'); // only one set + id binding
    expect(params).toEqual(['A', 1]);
  });

  it('skips undefined values', async () => {
    query.mockResolvedValue({ rows: [{ id: 1 }] });
    await watchlistRepository.update(1, { name: 'A', notes: undefined });
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('notes');
    expect(params).toEqual(['A', 1]);
  });

  it('falls back to getById when no allowed fields present', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, name: 'unchanged' }] });
    const result = await watchlistRepository.update(1, { forbidden: 'x' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('SELECT * FROM watchlist WHERE id = $1');
    expect(result).toEqual({ id: 1, name: 'unchanged' });
  });

  it('returns null when row is missing', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await watchlistRepository.update(404, { name: 'X' })).toBeNull();
  });
});

describe('watchlistRepository.delete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when a row was deleted', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    expect(await watchlistRepository.delete(1)).toBe(true);
  });

  it('returns false when no row was deleted', async () => {
    query.mockResolvedValue({ rowCount: 0 });
    expect(await watchlistRepository.delete(404)).toBe(false);
  });

  it('passes id as a single param', async () => {
    query.mockResolvedValue({ rowCount: 1 });
    await watchlistRepository.delete(7);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toBe('DELETE FROM watchlist WHERE id = $1');
    expect(params).toEqual([7]);
  });
});
