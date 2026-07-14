import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  // Transaction shim: run the callback directly; a throw propagates (= rollback).
  withTransaction: vi.fn(async (fn) => fn({ query: vi.fn() })),
}));

import { query, withTransaction } from '../src/database/connection.js';
import { normalizeReconcile, reconcileAccount } from '../src/services/reconcileService.js';

beforeEach(() => vi.clearAllMocks());

describe('normalizeReconcile (ADR-094 Phase C)', () => {
  it("accepts mode 'accept'", () => {
    expect(normalizeReconcile({ mode: 'accept' })).toEqual({ mode: 'accept' });
  });

  it("accepts mode 'adjustment'", () => {
    expect(normalizeReconcile({ mode: 'adjustment' })).toEqual({ mode: 'adjustment' });
  });

  it('rejects a missing or unknown mode', () => {
    expect(() => normalizeReconcile({})).toThrow(/mode/);
    expect(() => normalizeReconcile({ mode: 'delete' })).toThrow(/mode/);
  });
});

describe('reconcileAccount (ADR-094 Phase C)', () => {
  it('404s when the account does not exist', async () => {
    // The FOR UPDATE lock select returns no row → NotFound before the drift read.
    query.mockResolvedValueOnce({ rows: [] });
    await expect(reconcileAccount(99, { mode: 'accept' })).rejects.toThrow(/not found/i);
    // First (and only) query is the lock, and it must take FOR UPDATE.
    expect(query.mock.calls[0][0]).toMatch(/FOR UPDATE/);
  });

  it('rejects when the account has no statement balance', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // lock
      .mockResolvedValueOnce({ rows: [{ currency: 'EUR', statement_balance: null, computed_balance: 100 }] });
    await expect(reconcileAccount(5, { mode: 'accept' })).rejects.toThrow(/no statement balance/i);
  });

  it('rejects a no-op reconcile when drift is within epsilon', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // lock
      .mockResolvedValueOnce({ rows: [{ currency: 'EUR', statement_balance: 100, computed_balance: 100 }] });
    await expect(reconcileAccount(5, { mode: 'accept' })).rejects.toThrow(/already reconciled/i);
  });

  it('runs the whole reconcile inside a transaction and locks the account row first', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // lock
      .mockResolvedValueOnce({ rows: [{ currency: 'EUR', statement_balance: 120, computed_balance: 100 }] })
      .mockResolvedValueOnce({ rows: [{ id: 77, amount: 20, transfer_source: 'adjustment' }] });

    await reconcileAccount(5, { mode: 'adjustment' });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    // First query is the row lock, taken before the drift read.
    const [lockSql, lockParams] = query.mock.calls[0];
    expect(lockSql).toMatch(/SELECT id FROM accounts WHERE id = \$1 FOR UPDATE/);
    expect(lockParams).toEqual([5]);
  });

  it("accept mode rewrites the statement balance to the computed figure (drift → 0)", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // lock
      .mockResolvedValueOnce({ rows: [{ currency: 'EUR', statement_balance: 120, computed_balance: 100 }] })
      .mockResolvedValueOnce({ rows: [{ statement_balance: 100 }] });

    const result = await reconcileAccount(5, { mode: 'accept' });

    expect(result).toMatchObject({ mode: 'accept', drift: 0, statement_balance: 100, computed_balance: 100, transaction: null });

    // Third call is the UPDATE (after lock + drift read); the new statement figure is the computed balance.
    const [sql, params] = query.mock.calls[2];
    expect(sql).toMatch(/UPDATE accounts/);
    expect(sql).toMatch(/statement_balance = \$2/);
    expect(params[0]).toBe(5);
    expect(params[1]).toBe(100);
    expect(params[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("adjustment mode stamps a balance-free 'adjustment' delta row equal to the drift", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // lock
      .mockResolvedValueOnce({ rows: [{ currency: 'EUR', statement_balance: 120, computed_balance: 100 }] })
      .mockResolvedValueOnce({ rows: [{ id: 77, amount: 20, transfer_source: 'adjustment' }] });

    const result = await reconcileAccount(5, { mode: 'adjustment' });

    expect(result).toMatchObject({ mode: 'adjustment', drift: 0, statement_balance: 120, computed_balance: 120 });
    expect(result.transaction).toMatchObject({ id: 77, transfer_source: 'adjustment' });

    // Third call is the INSERT; amount is the drift, no `balance` column is written.
    const [sql, params] = query.mock.calls[2];
    expect(sql).toMatch(/INSERT INTO transactions/);
    expect(sql).toMatch(/transfer_source/);
    expect(sql).not.toMatch(/\bbalance\b/);
    // params: [today, amount, currency, memo, accountId]
    expect(params[1]).toBe(20);
    expect(params[2]).toBe('EUR');
    expect(params[4]).toBe(5);
  });

  it('handles a negative drift (statement below computed) with a negative adjustment', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }) // lock
      .mockResolvedValueOnce({ rows: [{ currency: 'USD', statement_balance: 80, computed_balance: 100 }] })
      .mockResolvedValueOnce({ rows: [{ id: 78, amount: -20, transfer_source: 'adjustment' }] });

    const result = await reconcileAccount(5, { mode: 'adjustment' });
    expect(result.computed_balance).toBe(80);
    const [, params] = query.mock.calls[2];
    expect(params[1]).toBe(-20);
  });
});
