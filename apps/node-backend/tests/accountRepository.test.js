/**
 * Account Repository tests (ADR-088). Mocks the DB layer and asserts the SQL /
 * params and the row shaping the repository performs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({ query: vi.fn() }));
// getAll folds the per-currency partitions into `accounts.currency` itself, so
// it needs a rate table. Stub it: this suite is about SQL + row shaping, and the
// real loader would otherwise reach for the DB (mocked away) and then the ECB.
vi.mock('../src/services/currency/currencyConversionService.js', () => ({
  loadCurrentRates: vi.fn(async () => ({ EUR: 1, USD: 0.5 })),
  // rate_to_eur semantics, mirroring the real convertWithRates.
  convertWithRates: vi.fn((amount, from, to, rates) =>
    (from === to ? amount : (amount * rates[from]) / rates[to])),
}));

import { query } from '../src/database/connection.js';
import accountRepository from '../src/repositories/accountRepository.js';

describe('accountRepository', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('getAll', () => {
    it('lists all accounts without an active filter', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Checking' }] });
      const rows = await accountRepository.getAll();
      // No partitions at all (an account with no active rows) → a 0 balance and
      // no drift, with the provenance fields absent rather than null.
      expect(rows).toEqual([{
        id: 1,
        name: 'Checking',
        computed_balance: 0,
        reconcilable_balance: 0,
        reconcilable_currency: 'EUR',
        drift: null,
        anchor_date: undefined,
        post_anchor_count: undefined,
      }]);
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

    it('selects the provenance columns from the shared lateral (WP-B2)', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await accountRepository.getAll();
      const sql = query.mock.calls[0][0];
      expect(sql).toContain('lb.anchor_date');
      expect(sql).toContain('lb.post_anchor_count');
      // The balance no longer comes off the cross-currency lateral: it is summed
      // in JS from the per-currency partitions, which arrive as one JSON column.
      expect(sql).not.toContain('lb.balance AS computed_balance');
      expect(sql).toContain('bp.balance_parts');
    });

    // The defect this replaced: SUM(t2.amount) added a EUR amount to a USD
    // amount as bare numbers, and the caller converted that total at the single
    // rate of the most recent row's currency — 100 EUR + 100 USD at 0.5 came out
    // as 100 instead of 150.
    it('sums the currency partitions into the account currency, not across them', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 1, name: 'Wise', currency: 'EUR', statement_balance: null,
          balance_parts: [
            { currency: 'EUR', balance: '100.0000' },
            { currency: 'USD', balance: '100.0000' },
          ],
        }],
      });
      const [row] = await accountRepository.getAll();
      expect(row.computed_balance).toBe(150); // 100 EUR + 100 USD × 0.5
      expect(row.balance_parts).toBeUndefined(); // internal, not part of the payload
    });

    // Drift is the statement figure against the partition it is a statement FOR
    // (the account's own currency), never against the FX-converted total — which
    // would make a reconciliation figure move with the daily rate.
    it('derives drift from the account-currency partition on a multi-currency account', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 1, name: 'Wise', currency: 'EUR', statement_balance: '120.00',
          balance_parts: [
            { currency: 'EUR', balance: '100.0000' },
            { currency: 'USD', balance: '100.0000' },
          ],
        }],
      });
      const [row] = await accountRepository.getAll();
      expect(row.computed_balance).toBe(150);
      expect(row.drift).toBe(20); // 120 − the EUR partition's 100, NOT 120 − 150
      // …and the base behind that subtraction is emitted, so the reconcile
      // dialog can preview an entered reading against the SAME figure the
      // server will resolve against instead of against computed_balance.
      expect(row.reconcilable_balance).toBe(100);
      expect(row.reconcilable_currency).toBe('EUR');
      expect(row.drift).toBe((row.statement_balance ?? 0) - row.reconcilable_balance);
    });

    // Every consumer of the three native figures relies on this identity.
    it('emits reconcilable_balance == computed_balance on a single-currency account', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 1, name: 'KBC', currency: 'EUR', statement_balance: '90.00',
          balance_parts: [{ currency: 'EUR', balance: '100.0000' }],
        }],
      });
      const [row] = await accountRepository.getAll();
      expect(row.computed_balance).toBe(100);
      expect(row.reconcilable_balance).toBe(100);
      expect(row.reconcilable_currency).toBe('EUR');
      expect(row.drift).toBe(-10);
    });

    // D4: the statement names a currency the account holds nothing in. The base
    // is 0 and 'accept' will write 0 — surfacing the base is what makes that
    // outcome visible in the dialog instead of arriving unannounced.
    it('emits a zero base when no partition matches the account currency', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 1, name: 'GBP shell', currency: 'GBP', statement_balance: '50.00',
          balance_parts: [
            { currency: 'EUR', balance: '100.0000' },
            { currency: 'USD', balance: '100.0000' },
          ],
        }],
      });
      const [row] = await accountRepository.getAll();
      expect(row.reconcilable_balance).toBe(0);
      expect(row.reconcilable_currency).toBe('GBP');
      expect(row.drift).toBe(50);
    });

    // The mislabelled single-currency account: one partition reconciles against
    // the statement whatever its code, so nothing regresses for the common case.
    it('reconciles a lone partition even when its currency differs from the account', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 1, name: 'Wise USD', currency: 'EUR', statement_balance: '90.00',
          balance_parts: [{ currency: 'USD', balance: '100.0000' }],
        }],
      });
      const [row] = await accountRepository.getAll();
      expect(row.computed_balance).toBe(50); // 100 USD × 0.5, into the account's EUR
      expect(row.drift).toBe(-10); // native: 90 − the sole partition's 100
      // D3: the base carries the partition's OWN code, so the dialog can label
      // the statement/base/difference triple honestly (all USD) beside the
      // converted computed_balance instead of printing a USD drift as EUR.
      expect(row.reconcilable_balance).toBe(100);
      expect(row.reconcilable_currency).toBe('USD');
    });

    // D2: a cancelled/offsetting foreign transfer pair nets to zero but still
    // creates a partition. It must not move the reconciliation base.
    it('ignores a zero-sum partition when resolving the base', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: 1, name: 'Noisy', currency: 'EUR', statement_balance: '100.00',
          balance_parts: [
            { currency: 'GBP', balance: '0.0000' }, // offsetting pair, net 0
            { currency: 'USD', balance: '100.0000' },
          ],
        }],
      });
      const [row] = await accountRepository.getAll();
      expect(row.reconcilable_balance).toBe(100); // the USD partition, as if the noise were absent
      expect(row.reconcilable_currency).toBe('USD');
      expect(row.drift).toBe(0); // was 100 — the whole balance — before the noise was dropped
    });

    it('shapes provenance: NULL anchor_date → undefined, bigint-string count → number', async () => {
      query.mockResolvedValueOnce({
        rows: [
          // (a) stamped anchor + entries since — count arrives as a pg bigint string
          { id: 1, name: 'KBC', anchor_date: '2026-06-30', post_anchor_count: '2' },
          // (b) nothing stamped — SQL NULL anchor, count = all active rows
          { id: 2, name: 'Cash', anchor_date: null, post_anchor_count: '3' },
        ],
      });
      const rows = await accountRepository.getAll();
      expect(rows[0].anchor_date).toBe('2026-06-30');
      expect(rows[0].post_anchor_count).toBe(2);
      // Backend never returns null — SQL NULL maps to undefined at the boundary.
      expect(rows[1].anchor_date).toBeUndefined();
      expect(rows[1].post_anchor_count).toBe(3);
    });

    // Pagination is opt-in — no limit means no LIMIT clause, so the historical
    // "every account" behaviour is preserved byte for byte.
    it('emits no LIMIT/OFFSET when no limit is supplied', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await accountRepository.getAll({ active: true });
      // (the balance lateral has its own literal LIMIT — assert on the
      // parameterized tail this helper appends, not on the word)
      expect(query.mock.calls[0][0]).not.toContain('LIMIT $');
      expect(query.mock.calls[0][1]).toEqual([]);
    });

    it('appends a parameterized LIMIT/OFFSET when a limit is supplied', async () => {
      query.mockResolvedValueOnce({ rows: [] });
      await accountRepository.getAll({ active: true, limit: 25, offset: 50 });
      expect(query.mock.calls[0][0]).toContain('LIMIT $1 OFFSET $2');
      expect(query.mock.calls[0][1]).toEqual([25, 50]);
    });
  });

  describe('getCount', () => {
    it('counts with the same active filter and coerces the bigint string', async () => {
      query.mockResolvedValueOnce({ rows: [{ count: '42' }] });
      expect(await accountRepository.getCount({ active: false })).toBe(42);
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

    it('getByName matches on the normalized identity (D1: case/whitespace-insensitive)', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 3, name: 'Brokerage' }] });
      const r = await accountRepository.getByName('Brokerage');
      expect(r.id).toBe(3);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('lower(btrim(name)) = lower(btrim($1))'),
        ['Brokerage'],
      );
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
    it('trims and upserts on the normalized identity, returning the id', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 21 }] });
      const id = await accountRepository.resolveOrCreateByName('  My Bank  ');
      expect(id).toBe(21);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT (lower(btrim(name)))'),
        ['My Bank'],
      );
      // The existing row keeps its stored casing — the conflict arm must not
      // overwrite name with the incoming label.
      expect(query.mock.calls[0][0]).toContain('DO UPDATE SET name = accounts.name');
    });

    it('returns undefined for a blank name without touching the DB', async () => {
      expect(await accountRepository.resolveOrCreateByName('   ')).toBeUndefined();
      expect(query).not.toHaveBeenCalled();
    });
  });
});
