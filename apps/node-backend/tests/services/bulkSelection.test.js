/**
 * bulkSelection — id/filter resolver unit tests. No Express, no real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockConnection } from '../helpers/repoMocks.js';
vi.mock('../../src/database/connection.js', () => mockConnection({ getClient: vi.fn() }));

const { resolveBulkSelection, normalizeBulkFilter, BULK_SELECTION_DEFAULTS } =
  await import('../../src/services/bulkSelection.js');
const { query: dbQuery } = await import('../../src/database/connection.js');

describe('resolveBulkSelection — input validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when neither ids nor filter is provided', async () => {
    await expect(resolveBulkSelection({})).rejects.toThrow(/either .* or .* must be provided/i);
  });

  it('throws when both ids and filter are provided', async () => {
    await expect(
      resolveBulkSelection({ ids: [1], filter: { search: 'foo' } }),
    ).rejects.toThrow(/not both/i);
  });

  it('throws when ids is an empty array', async () => {
    await expect(resolveBulkSelection({ ids: [] })).rejects.toThrow(/either .* or .* must be provided/i);
  });

  it('throws when ids exceeds the cap', async () => {
    const oversized = Array.from({ length: 501 }, (_, i) => i + 1);
    await expect(resolveBulkSelection({ ids: oversized })).rejects.toThrow(/at most 500/);
  });

  it('honours a custom idCap', async () => {
    await expect(
      resolveBulkSelection({ ids: [1, 2, 3, 4] }, { idCap: 3 }),
    ).rejects.toThrow(/at most 3/);
  });

  it('throws when ids contains no valid integers', async () => {
    await expect(resolveBulkSelection({ ids: ['abc', null, -5, 0] })).rejects.toThrow(
      /no valid integer ids/i,
    );
  });
});

describe('resolveBulkSelection — id mode happy path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the sanitized id list and never queries the DB', async () => {
    const result = await resolveBulkSelection({ ids: [1, 2, 3] });
    expect(result).toEqual([1, 2, 3]);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('drops invalid ids while preserving valid ones', async () => {
    const result = await resolveBulkSelection({ ids: [1, 'abc', 2, -5, 3] });
    expect(result).toEqual([1, 2, 3]);
  });
});

describe('resolveBulkSelection — filter mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when filter matches no rows', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ n: 0 }] });
    await expect(
      resolveBulkSelection({ filter: { search: 'nothing' } }),
    ).rejects.toThrow(/matches no transactions/);
  });

  it('throws when filter matches more rows than the cap', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ n: 7000 }] });
    await expect(
      resolveBulkSelection({ filter: { search: 'big' } }),
    ).rejects.toThrow(/matches 7000 transactions; cap is 5000/);
  });

  it('respects a custom filterCap', async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ n: 200 }] });
    await expect(
      resolveBulkSelection({ filter: { search: 'x' } }, { filterCap: 100 }),
    ).rejects.toThrow(/matches 200 transactions; cap is 100/);
  });

  it('returns ids from a valid filter request', async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ n: 3 }] })
      .mockResolvedValueOnce({ rows: [{ id: 11 }, { id: 12 }, { id: 13 }] });

    const result = await resolveBulkSelection({ filter: { search: 'cafe' } });
    expect(result).toEqual([11, 12, 13]);
    expect(dbQuery).toHaveBeenCalledTimes(2);
  });
});

describe('normalizeBulkFilter', () => {
  it('accepts snake_case keys from the wire', () => {
    const out = normalizeBulkFilter({
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      category_id: 7,
      recipient_id: 99,
      transaction_type: 'expense',
      tags: 'rome-2020,work',
    });
    expect(out.startDate).toBe('2026-01-01');
    expect(out.endDate).toBe('2026-12-31');
    expect(out.categoryId).toBe(7);
    expect(out.recipientId).toBe(99);
    expect(out.transactionType).toBe('expense');
    expect(out.tagSlugs).toEqual(['rome-2020', 'work']);
  });

  it('accepts camelCase keys', () => {
    const out = normalizeBulkFilter({ startDate: '2026-01-01', tagSlugs: ['rome-2020'] });
    expect(out.startDate).toBe('2026-01-01');
    expect(out.tagSlugs).toEqual(['rome-2020']);
  });

  it('returns empty object on null input', () => {
    expect(normalizeBulkFilter(null)).toEqual({});
    expect(normalizeBulkFilter(undefined)).toEqual({});
  });
});

describe('BULK_SELECTION_DEFAULTS', () => {
  it('exposes the documented caps', () => {
    expect(BULK_SELECTION_DEFAULTS.idCap).toBe(500);
    expect(BULK_SELECTION_DEFAULTS.filterCap).toBe(5000);
  });
});
