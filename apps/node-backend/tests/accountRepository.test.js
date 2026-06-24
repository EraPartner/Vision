/**
 * Account Repository tests (ADR-088). Mocks the DB layer and asserts the SQL /
 * params and the row shaping the repository performs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({ query: vi.fn() }));

import { query } from '../src/database/connection.js';
import accountRepository from '../src/repositories/accountRepository.js';

describe('accountRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getAll', () => {
    it('lists all accounts without an active filter', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Checking' }] });
      const rows = await accountRepository.getAll();
      expect(rows).toEqual([{ id: 1, name: 'Checking' }]);
      const sql = query.mock.calls[0][0];
      expect(sql).not.toContain('a.is_active = true');
      expect(sql).not.toContain('a.is_active = false');
      expect(sql).toContain('ORDER BY a.name');
    });

    it('filters to active accounts', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await accountRepository.getAll({ active: true });
      expect(query.mock.calls[0][0]).toContain('a.is_active = true');
    });

    it('filters to inactive accounts', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await accountRepository.getAll({ active: false });
      expect(query.mock.calls[0][0]).toContain('a.is_active = false');
    });
  });

  describe('getById / getByName', () => {
    it('returns the row when found', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 7, name: 'Savings' }] });
      expect(await accountRepository.getById(7)).toEqual({ id: 7, name: 'Savings' });
      expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), [7]);
    });

    it('returns undefined when not found', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      expect(await accountRepository.getById(99)).toBeUndefined();
    });

    it('getByName queries by name', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 3, name: 'Brokerage' }] });
      const r = await accountRepository.getByName('Brokerage');
      expect(r.id).toBe(3);
      expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE name = $1'), ['Brokerage']);
    });
  });

  describe('create', () => {
    it('writes only whitelisted, defined fields', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 11, name: 'New' }] });
      const r = await accountRepository.create({
        name: 'New',
        currency: 'EUR',
        bogus: 'ignored', // not in WRITABLE
        type: undefined, // skipped
      });
      expect(r.id).toBe(11);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('INSERT INTO accounts');
      expect(sql).toContain('"name"');
      expect(sql).toContain('"currency"');
      expect(sql).not.toContain('bogus');
      expect(params).toEqual(['New', 'EUR']);
    });
  });

  describe('update', () => {
    it('builds a SET clause and appends updated_at', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 5, display_name: 'X' }] });
      const r = await accountRepository.update(5, { display_name: 'X', nope: 1 });
      expect(r.display_name).toBe('X');
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('"display_name" = $1');
      expect(sql).toContain('updated_at = NOW()');
      expect(sql).toContain('WHERE id = $2');
      expect(params).toEqual(['X', 5]);
    });

    it('falls back to getById when no writable fields are provided', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 5, name: 'Same' }] });
      const r = await accountRepository.update(5, { nope: 1 });
      expect(r.name).toBe('Same');
      // Only the getById SELECT runs, not an UPDATE.
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain('SELECT');
    });

    it('returns undefined when the update affects no row', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      expect(await accountRepository.update(1, { currency: 'USD' })).toBeUndefined();
    });
  });

  describe('remove', () => {
    it('returns the deleted id', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 8 }] });
      expect(await accountRepository.remove(8)).toBe(8);
    });

    it('returns undefined when nothing was deleted', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      expect(await accountRepository.remove(8)).toBeUndefined();
    });
  });

  describe('resolveOrCreateByName', () => {
    it('trims and upserts, returning the id', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 21 }] });
      const id = await accountRepository.resolveOrCreateByName('  My Bank  ');
      expect(id).toBe(21);
      expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (name)'), ['My Bank']);
    });

    it('returns undefined for a blank name without touching the DB', async () => {
      expect(await accountRepository.resolveOrCreateByName('   ')).toBeUndefined();
      expect(query).not.toHaveBeenCalled();
    });
  });
});
