/**
 * Recipient Repository tests. Mocks the DB and the text-normalization helper to
 * assert the SQL the repository builds and how it shapes rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../src/lib/textNormalization.js', () => ({
  normalizeForMatching: vi.fn((s) => `norm:${String(s).trim().toLowerCase()}`),
}));

import { query } from '../src/database/connection.js';
import recipientRepository from '../src/repositories/recipientRepository.js';

describe('recipientRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getAll', () => {
    it('uses default sort and pagination params', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      const rows = await recipientRepository.getAll();
      expect(rows).toEqual([{ id: 1 }]);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('ORDER BY r.name ASC');
      expect(sql).toContain('r.is_active = true'); // active defaults true
      // [...whereParams, limit, offset]; default limit 50 offset 0
      expect(params[params.length - 2]).toBe(50);
      expect(params[params.length - 1]).toBe(0);
    });

    it('applies name, search and a whitelisted sort column descending', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await recipientRepository.getAll({ name: 'aldi', search: 'food', sortBy: 'notes', sortDir: 'desc', active: false });
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('r.name ILIKE');
      expect(sql).toContain('rba.account_number ILIKE');
      expect(sql).toContain('r.notes DESC, r.name ASC');
      expect(sql).not.toContain('r.is_active = true');
      expect(params).toContain('%aldi%');
      expect(params).toContain('%food%');
    });

    it('uncategorized branch overrides defaultCategoryId filter', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await recipientRepository.getAll({ uncategorized: true, defaultCategoryId: 5 });
      const sql = query.mock.calls[0][0];
      // Existence probe now hits transactions directly (agg_recipient_totals
      // was dropped in migration 0080); assert the equivalent semantics.
      expect(sql).not.toContain('agg_recipient_totals');
      expect(sql).toContain('FROM transactions t');
      expect(sql).toContain('t.is_active = true');
      expect(sql).toContain('t.is_transfer = false');
      expect(sql).toContain('r.default_category_id IS NULL');
      expect(sql).not.toContain('r.default_category_id = $');
    });

    it('ignores an unknown sort column and falls back to name', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await recipientRepository.getAll({ sortBy: 'evil; DROP', sortDir: 'asc' });
      expect(query.mock.calls[0][0]).toContain('ORDER BY r.name ASC');
    });
  });

  describe('getCount', () => {
    it('parses the count and applies the category filter', async () => {
      query.mockResolvedValueOnce({ rows: [{ count: '42' }] });
      const n = await recipientRepository.getCount({ defaultCategoryId: 9 });
      expect(n).toBe(42);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('count(*)');
      expect(sql).toContain('r.default_category_id = $1');
      expect(params).toEqual([9]);
    });
  });

  describe('getById / getByName', () => {
    it('getById returns the row', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 3, name: 'X' }] });
      expect(await recipientRepository.getById(3)).toEqual({ id: 3, name: 'X' });
    });

    it('getById returns null when absent', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      expect(await recipientRepository.getById(3)).toBeNull();
    });

    it('getByName normalizes the lookup', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 4 }] });
      const r = await recipientRepository.getByName('  Aldi ');
      expect(r.id).toBe(4);
      expect(query).toHaveBeenCalledWith(expect.stringContaining('normalized_name = $1'), ['norm:aldi']);
    });
  });

  describe('createOrGet', () => {
    it('returns created=true on a fresh insert', async () => {
      query
        .mockResolvedValueOnce({ rows: [{ id: 10 }] }) // insert returns id
        .mockResolvedValueOnce({ rows: [{ id: 10, name: 'ALDI' }] }); // getById
      const r = await recipientRepository.createOrGet({ name: 'aldi' });
      expect(r.created).toBe(true);
      expect(r.recipient).toEqual({ id: 10, name: 'ALDI' });
      expect(query.mock.calls[0][1]).toEqual(['ALDI', 'norm:aldi']); // upper + normalized
    });

    it('returns created=false when the recipient already exists', async () => {
      query
        .mockResolvedValueOnce({ rows: [] }) // insert conflict, DO NOTHING
        .mockResolvedValueOnce({ rows: [{ id: 7 }] }) // existing select
        .mockResolvedValueOnce({ rows: [{ id: 7, name: 'ALDI' }] }); // getById
      const r = await recipientRepository.createOrGet({ name: 'Aldi' });
      expect(r.created).toBe(false);
      expect(r.recipient.id).toBe(7);
    });

    it('throws if the conflict row cannot be re-read', async () => {
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      await expect(recipientRepository.createOrGet({ name: 'ghost' })).rejects.toThrow('not found after conflict');
    });
  });

  describe('getOrCreateSystemId', () => {
    // The hit path is every call but the first one ever. It must not write: an
    // ON CONFLICT DO UPDATE no-op fires the updated_at trigger, leaves a dead
    // tuple, advances xmin (breaking the DB editor's optimistic-concurrency
    // check on an adopted user recipient) and holds the row exclusively locked
    // for the rest of the caller's transaction.
    it('resolves an existing row with a single SELECT and no write', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 900 }] });
      expect(await recipientRepository.getOrCreateSystemId()).toBe(900);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/^\s*SELECT id FROM recipients WHERE normalized_name/);
      expect(params).toEqual(['norm:system']);
    });

    it('falls through to a conflict-safe INSERT only when the row is missing', async () => {
      query
        .mockResolvedValueOnce({ rows: [] }) // miss
        .mockResolvedValueOnce({ rows: [{ id: 901 }] });
      expect(await recipientRepository.getOrCreateSystemId()).toBe(901);
      const [sql, params] = query.mock.calls[1];
      expect(sql).toMatch(/INSERT INTO recipients/);
      // Created inactive, and DO UPDATE (not DO NOTHING) so a concurrent
      // uncommitted insert blocks and still returns an id.
      expect(sql).toMatch(/VALUES \(\$1, \$2, false\)/);
      expect(sql).toMatch(/ON CONFLICT \(normalized_name\) DO UPDATE/);
      expect(params).toEqual(['SYSTEM', 'norm:system']);
    });
  });

  describe('update', () => {
    it('builds SET clauses for name (upper + normalized) and other fields', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'NEW' }] });
      const r = await recipientRepository.update(1, { name: 'new', notes: 'hi', is_active: false });
      expect(r.name).toBe('NEW');
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('name = $1');
      expect(sql).toContain('normalized_name = $2');
      expect(sql).toContain('updated_at = NOW()');
      expect(params).toEqual(['NEW', 'norm:new', 'hi', false, 1]);
    });

    it('falls back to getById when nothing to update', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      const r = await recipientRepository.update(1, {});
      expect(r.id).toBe(1);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain('WHERE r.id = $1');
    });
  });

  describe('mutations', () => {
    it('hardDelete reflects rowCount', async () => {
      query.mockResolvedValueOnce({ rowCount: 1 });
      expect(await recipientRepository.hardDelete(2)).toBe(true);
      query.mockResolvedValueOnce({ rowCount: 0 });
      expect(await recipientRepository.hardDelete(2)).toBe(false);
    });

    it('mergeRecipients short-circuits with no aliases', async () => {
      expect(await recipientRepository.mergeRecipients(1, [])).toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });

    it('mergeRecipients updates aliases and returns their ids', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 2 }, { id: 3 }] });
      const ids = await recipientRepository.mergeRecipients(1, [2, 3]);
      expect(ids).toEqual([2, 3]);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('id IN ($2,$3)');
      expect(params).toEqual([1, 2, 3]);
    });

    it('unmergeRecipient returns boolean', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 5 }] });
      expect(await recipientRepository.unmergeRecipient(5)).toBe(true);
      query.mockResolvedValueOnce({ rows: [] });
      expect(await recipientRepository.unmergeRecipient(5)).toBe(false);
    });

    it('getAliases returns rows', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 8 }] });
      expect(await recipientRepository.getAliases(1)).toEqual([{ id: 8 }]);
    });
  });

  describe('getClusterRootMap', () => {
    it('returns an empty map for empty/null input', async () => {
      expect(await recipientRepository.getClusterRootMap([])).toEqual(new Map());
      expect(await recipientRepository.getClusterRootMap(null)).toEqual(new Map());
      expect(query).not.toHaveBeenCalled();
    });

    it('dedupes ids and maps id -> cluster root', async () => {
      query.mockResolvedValueOnce({
        rows: [{ id: 1, cluster_root: 1 }, { id: 2, cluster_root: 1 }],
      });
      const map = await recipientRepository.getClusterRootMap([1, 2, 2, null]);
      expect(map.get(1)).toBe(1);
      expect(map.get(2)).toBe(1);
      expect(query.mock.calls[0][1]).toEqual([[1, 2]]);
    });
  });
});
