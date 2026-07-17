import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockTxConnection } from './helpers/repoMocks.js';
const { mockClient } = vi.hoisted(() => ({ mockClient: { query: vi.fn() } }));

vi.mock('../src/database/connection.js', () => mockTxConnection(mockClient));

import { mergeAccounts } from '../src/services/accountMergeService.js';
import { ValidationError, NotFoundError } from '../src/middleware/errorHandler.js';

// Default happy-path SQL router: target #2 ('TARGET'), source #1 exists.
function happyPath() {
  mockClient.query.mockImplementation(async (sql) => {
    if (sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1')) return { rows: [{ id: 2, name: 'TARGET' }] };
    if (sql.includes('FOR UPDATE') && sql.includes('ANY')) return { rows: [{ id: 1 }] };
    if (sql.includes('UPDATE transactions')) return { rowCount: 3 };
    if (sql.includes('UPDATE planned_transactions')) return { rowCount: 1 };
    if (sql.includes('to_regclass')) return { rows: [{ r: 'public.portfolio_transactions_base' }] };
    if (sql.includes('UPDATE portfolio_transactions_base')) return { rowCount: 2 };
    if (sql.includes('UPDATE accounts SET funding_account_id')) return { rowCount: 0 };
    if (sql.includes('DELETE FROM accounts')) return { rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => vi.clearAllMocks());

describe('mergeAccounts (ADR-088)', () => {
  it('rejects an empty / self-only source set', async () => {
    await expect(mergeAccounts(2, [])).rejects.toThrow(ValidationError);
    await expect(mergeAccounts(2, [2])).rejects.toThrow(ValidationError);
  });

  it('throws NotFound when the survivor is missing', async () => {
    mockClient.query.mockImplementation(async (sql) =>
      sql.includes('WHERE id = $1') ? { rows: [] } : { rows: [], rowCount: 0 });
    await expect(mergeAccounts(2, [1])).rejects.toThrow(NotFoundError);
  });

  it('throws NotFound when a source is missing', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('WHERE id = $1')) return { rows: [{ id: 2, name: 'TARGET' }] };
      if (sql.includes('ANY')) return { rows: [] }; // no sources found
      return { rows: [], rowCount: 0 };
    });
    await expect(mergeAccounts(2, [1])).rejects.toThrow(NotFoundError);
  });

  it('repoints every reference to the survivor, deletes the source, returns counts', async () => {
    happyPath();
    const result = await mergeAccounts(2, [1]);

    expect(result).toEqual({
      into: 2,
      merged: [1],
      reassigned: { transactions: 3, planned: 1, portfolio: 2, funding: 0 },
    });

    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calls.some((s) => s.includes('UPDATE transactions') && s.includes('bank_account'))).toBe(true);
    expect(calls.some((s) => s.includes('UPDATE planned_transactions'))).toBe(true);
    expect(calls.some((s) => s.includes('UPDATE portfolio_transactions_base'))).toBe(true);
    expect(calls.some((s) => s.includes('UPDATE accounts SET funding_account_id'))).toBe(true);
    expect(calls.some((s) => s.includes('DELETE FROM accounts'))).toBe(true);

    // transactions repoint carries the survivor's name (so the dual-write trigger keeps it merged)
    const txCall = mockClient.query.mock.calls.find(([sql]) => sql.includes('UPDATE transactions'));
    expect(txCall[1]).toEqual([2, 'TARGET', [1]]);
  });

  it('falls back to the flat portfolio_transactions table when there is no inheritance base', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1')) return { rows: [{ id: 2, name: 'T' }] };
      if (sql.includes('FOR UPDATE') && sql.includes('ANY')) return { rows: [{ id: 1 }] };
      if (sql.includes('to_regclass')) return { rows: [{ r: null }] }; // flat schema
      if (sql.includes('UPDATE portfolio_transactions ')) return { rowCount: 5 };
      return { rows: [], rowCount: 0 };
    });
    const result = await mergeAccounts(2, [1]);
    expect(result.reassigned.portfolio).toBe(5);
    const calls = mockClient.query.mock.calls.map(([sql]) => sql);
    expect(calls.some((s) => s.includes('UPDATE portfolio_transactions ') && !s.includes('_base'))).toBe(true);
  });
});
