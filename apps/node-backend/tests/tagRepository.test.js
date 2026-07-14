import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query } from '../src/database/connection.js';
import tagRepository from '../src/repositories/tagRepository.js';

describe('tagRepository.getAll', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds is_active = true clause when active=true', async () => {
    query.mockResolvedValue({ rows: [] });
    await tagRepository.getAll({ active: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('is_active = true'), [50, 0]);
  });

  it('adds is_active = false clause when active=false', async () => {
    query.mockResolvedValue({ rows: [] });
    await tagRepository.getAll({ active: false });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('is_active = false'), [50, 0]);
  });

  it('omits is_active filter when active=null', async () => {
    query.mockResolvedValue({ rows: [] });
    await tagRepository.getAll({ active: null });
    const [sql] = query.mock.calls[0];
    expect(sql).not.toContain('is_active');
  });

  it('always orders by slug', async () => {
    query.mockResolvedValue({ rows: [] });
    await tagRepository.getAll({});
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY slug'),
      expect.any(Array),
    );
  });

  it('applies LIMIT/OFFSET with default page size when unspecified', async () => {
    query.mockResolvedValue({ rows: [] });
    await tagRepository.getAll({});
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('LIMIT $1 OFFSET $2');
    expect(params).toEqual([50, 0]);
  });

  it('passes through explicit limit and offset', async () => {
    query.mockResolvedValue({ rows: [] });
    await tagRepository.getAll({ active: true, limit: 10, offset: 20 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $1 OFFSET $2'),
      [10, 20],
    );
  });

  it('returns the rows from the query result', async () => {
    const rows = [{ id: 1, slug: 'rome-2020', color: '#f00', is_active: true }];
    query.mockResolvedValue({ rows });
    const result = await tagRepository.getAll({ active: true });
    expect(result).toEqual(rows);
  });
});

describe('tagRepository.getCount', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the count as an integer', async () => {
    query.mockResolvedValue({ rows: [{ count: '12' }] });
    const total = await tagRepository.getCount({ active: true });
    expect(total).toBe(12);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('COUNT(*)'),
      [],
    );
  });

  it('applies the is_active filter matching getAll', async () => {
    query.mockResolvedValue({ rows: [{ count: '0' }] });
    await tagRepository.getCount({ active: false });
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('is_active = false');
  });

  it('omits the is_active filter when active=null', async () => {
    query.mockResolvedValue({ rows: [{ count: '3' }] });
    await tagRepository.getCount({ active: null });
    const [sql] = query.mock.calls[0];
    expect(sql).not.toContain('is_active');
  });
});

describe('tagRepository.findOrCreateBySlug', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns reactivated=false for a new tag (was_conflict=false)', async () => {
    query.mockResolvedValue({
      rows: [{ id: 1, slug: 'rome-2020', color: null, is_active: true, was_conflict: false }],
    });
    const { tag, reactivated } = await tagRepository.findOrCreateBySlug('rome-2020', null);
    expect(reactivated).toBe(false);
    expect(tag.slug).toBe('rome-2020');
  });

  it('returns reactivated=true when existing active row is updated (was_conflict=true)', async () => {
    query.mockResolvedValue({
      rows: [{ id: 2, slug: 'old-tag', color: '#blue', is_active: true, was_conflict: true }],
    });
    const { reactivated } = await tagRepository.findOrCreateBySlug('old-tag', '#blue');
    expect(reactivated).toBe(true);
  });

  it('strips was_conflict from the returned tag object', async () => {
    query.mockResolvedValue({
      rows: [{ id: 1, slug: 's', color: null, is_active: true, was_conflict: false }],
    });
    const { tag } = await tagRepository.findOrCreateBySlug('s', null);
    expect(tag).not.toHaveProperty('was_conflict');
  });

  it('uses INSERT ... ON CONFLICT upsert with slug and color params', async () => {
    query.mockResolvedValue({
      rows: [{ id: 3, slug: 'tag-a', color: '#abc', is_active: true, was_conflict: false }],
    });
    await tagRepository.findOrCreateBySlug('tag-a', '#abc');
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (slug) DO UPDATE'),
      ['tag-a', '#abc'],
    );
  });

  it('includes RETURNING ... (xmax <> 0) AS was_conflict in query', async () => {
    query.mockResolvedValue({
      rows: [{ id: 1, slug: 's', color: null, is_active: true, was_conflict: false }],
    });
    await tagRepository.findOrCreateBySlug('s', null);
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('was_conflict');
  });
});

describe('tagRepository.softDelete', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets is_active=false and returns the updated row', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, slug: 'rome', is_active: false }] });
    const result = await tagRepository.softDelete(1);
    expect(result).toMatchObject({ id: 1, is_active: false });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('is_active = false'),
      [1],
    );
  });

  it('returns null when no row found', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await tagRepository.softDelete(999);
    expect(result).toBeNull();
  });
});

describe('tagRepository.getManyBySlugs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array immediately without querying when given empty input', async () => {
    const result = await tagRepository.getManyBySlugs([]);
    expect(query).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('queries using ANY($1::text[]) for non-empty slug list', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, slug: 'rome-2020' }] });
    const result = await tagRepository.getManyBySlugs(['rome-2020', 'lisbon-2024']);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ANY($1::text[])'),
      [['rome-2020', 'lisbon-2024']],
    );
    expect(result).toHaveLength(1);
  });
});

describe('tagRepository.update', () => {
  beforeEach(() => vi.clearAllMocks());

  it('updates color and returns the updated row', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, slug: 'rome', color: '#f00', is_active: true }] });
    const result = await tagRepository.update(1, { color: '#f00' });
    expect(result).toMatchObject({ color: '#f00' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('color = $1'),
      expect.arrayContaining(['#f00', 1]),
    );
  });

  it('falls back to getById when no fields provided', async () => {
    query.mockResolvedValue({ rows: [{ id: 1, slug: 'rome' }] });
    await tagRepository.update(1, {});
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), [1]);
  });

  it('returns null when row not found', async () => {
    query.mockResolvedValue({ rows: [] });
    const result = await tagRepository.update(999, { color: '#f00' });
    expect(result).toBeNull();
  });
});

describe('tagRepository.countTransactionReferences', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns count as integer', async () => {
    query.mockResolvedValue({ rows: [{ count: '7' }] });
    const count = await tagRepository.countTransactionReferences(3);
    expect(count).toBe(7);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('transaction_tags'), [3]);
  });

  it('returns 0 when no references exist', async () => {
    query.mockResolvedValue({ rows: [{ count: '0' }] });
    expect(await tagRepository.countTransactionReferences(42)).toBe(0);
  });
});
