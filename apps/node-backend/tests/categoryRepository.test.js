import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockConnection } from './helpers/repoMocks.js';

vi.mock('../src/database/connection.js', () => mockConnection());

import { query } from '../src/database/connection.js';
import categoryRepository from '../src/repositories/categoryRepository.js';

describe('categoryRepository.createOrGet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts normalized category and returns created=true', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          general: 'FOOD',
          detail: 'GROCERIES',
          description: 'Weekly groceries',
          is_active: true,
        },
      ],
    });

    const result = await categoryRepository.createOrGet({
      general: '  food ',
      detail: ' groceries  ',
      description: 'Weekly groceries',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO categories'),
      ['FOOD', 'GROCERIES', 'Weekly groceries']
    );
    expect(result).toEqual({
      category: expect.objectContaining({
        id: 10,
        general: 'FOOD',
        detail: 'GROCERIES',
        category_name: 'FOOD:GROCERIES',
      }),
      created: true,
    });
  });

  it('returns existing enriched category with created=false on conflict fallback', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 3,
            general: 'UTILITIES',
            detail: 'ELECTRICITY',
            description: 'Power bill',
            is_active: true,
          },
        ],
      });

    const result = await categoryRepository.createOrGet({
      general: ' utilities ',
      detail: ' electricity ',
      description: 'ignored on conflict',
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('ON CONFLICT (general, detail) DO NOTHING'),
      ['UTILITIES', 'ELECTRICITY', 'ignored on conflict']
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT * FROM categories WHERE general = $1 AND detail = $2',
      ['UTILITIES', 'ELECTRICITY']
    );
    expect(result).toEqual({
      category: expect.objectContaining({
        id: 3,
        general: 'UTILITIES',
        detail: 'ELECTRICITY',
        category_name: 'UTILITIES:ELECTRICITY',
      }),
      created: false,
    });
  });
});

describe('categoryRepository query helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds filtered getAll query and enriches category_name', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 7,
          general: 'HOME',
          detail: 'RENT',
          description: 'Monthly rent',
          is_active: true,
        },
      ],
    });

    const result = await categoryRepository.getAll({
      general: 'hom',
      detail: 'ren',
      search: 'month',
      active: false,
      limit: 10,
      offset: 5,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('general ILIKE $1'),
      ['%hom%', '%ren%', '%month%', 10, 5]
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: 7,
        category_name: 'HOME:RENT',
      }),
    ]);
  });

  // Unbounded by default (buildLimitOffset): the full-list consumers (category
  // pickers/pages) must never be silently truncated to a default page.
  it('emits no LIMIT/OFFSET from getAll when pagination is not requested', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await categoryRepository.getAll({ active: true });

    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toContain('LIMIT');
    expect(params).toEqual([]);
  });

  it('returns parsed count from getCount filters', async () => {
    query.mockResolvedValueOnce({ rows: [{ count: '12' }] });

    const count = await categoryRepository.getCount({
      general: 'foo',
      detail: 'bar',
      search: 'baz',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT count(*) FROM categories'),
      ['%foo%', '%bar%', '%baz%']
    );
    expect(count).toBe(12);
  });

  it('returns null from getById when category does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await categoryRepository.getById(404);

    expect(query).toHaveBeenCalledWith('SELECT * FROM categories WHERE id = $1', [404]);
    expect(result).toBeNull();
  });
});

describe('categoryRepository mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns current row when update has no patchable fields', async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 9, general: 'FOOD', detail: 'DINING', description: null }],
    });

    const result = await categoryRepository.update(9, {});

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('SELECT * FROM categories WHERE id = $1', [9]);
    expect(result).toEqual(
      expect.objectContaining({
        id: 9,
        category_name: 'FOOD:DINING',
      })
    );
  });

  it('normalizes update fields and returns enriched row', async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          general: 'UTILITIES',
          detail: 'WATER',
          description: 'Water bill',
          is_active: true,
        },
      ],
    });

    const result = await categoryRepository.update(5, {
      general: ' utilities ',
      detail: ' water ',
      description: 'Water bill',
      is_active: true,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE categories SET'),
      ['UTILITIES', 'WATER', 'Water bill', true, 5]
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: 5,
        category_name: 'UTILITIES:WATER',
      })
    );
  });

  it('returns true from hardDelete when rowCount > 0', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });

    const deleted = await categoryRepository.hardDelete(3);

    expect(query).toHaveBeenCalledWith('DELETE FROM categories WHERE id = $1', [3]);
    expect(deleted).toBe(true);
  });

  it('returns updated recipient count from assignToRecipients', async () => {
    query.mockResolvedValueOnce({ rowCount: 2 });

    const updated = await categoryRepository.assignToRecipients(4, [10, 11]);

    expect(query).toHaveBeenCalledWith(
      'UPDATE recipients SET default_category_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])',
      [4, [10, 11]]
    );
    expect(updated).toBe(2);
  });
});
