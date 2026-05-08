import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/repositories/infoRepositoryHelpers.js', async () => {
  const actual = await vi.importActual('../src/repositories/infoRepositoryHelpers.js');
  return { ...actual, batchConvertGroupsWithHistoricalRateFallback: vi.fn() };
});

import { query } from '../src/database/connection.js';
import { batchConvertGroupsWithHistoricalRateFallback } from '../src/repositories/infoRepositoryHelpers.js';
import { banksRepository } from '../src/repositories/infoRepositoryBanks.js';

beforeEach(() => vi.clearAllMocks());

describe('banksRepository.getBankBalances', () => {
  it('returns empty when no transactions exist', async () => {
    query.mockResolvedValue({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);
    const r = await banksRepository.getBankBalances();
    expect(r).toEqual({
      accounts: [],
      total_net_position: 0,
      history: {},
      total_history: [],
    });
  });

  it('builds account list with current balance and total net position', async () => {
    query
      .mockResolvedValueOnce({
        rows: [
          { bank_account: 'A', currency: 'EUR', balance: '1000', date: '2025-04-15', transaction_count: '10', first_transaction: '2024-01-01', last_transaction: '2025-04-15' },
          { bank_account: 'B', currency: 'USD', balance: '200', date: '2025-04-15', transaction_count: '5', first_transaction: '2024-06-01', last_transaction: '2025-04-15' },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [
        { bank_account: 'A', amount_eur: 1000, transaction_count: '10', first_transaction: '2024-01-01', last_transaction: '2025-04-15' },
        { bank_account: 'B', amount_eur: 187.5, transaction_count: '5', first_transaction: '2024-06-01', last_transaction: '2025-04-15' },
      ],
      [],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.accounts).toHaveLength(2);
    expect(r.accounts[0]).toMatchObject({ bank_account: 'A', balance: 1000, transaction_count: 10 });
    expect(r.accounts[1]).toMatchObject({ bank_account: 'B', balance: 187.5, transaction_count: 5 });
    expect(r.total_net_position).toBe(1187.5);
  });

  it('groups historical balances by bank account, sorted by month asc', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { bank_account: 'A', month_start: '2025-03-01', currency: 'EUR', balance: '900', date: '2025-03-15' },
          { bank_account: 'A', month_start: '2025-04-01', currency: 'EUR', balance: '1000', date: '2025-04-15' },
          { bank_account: 'B', month_start: '2025-04-01', currency: 'EUR', balance: '500', date: '2025-04-15' },
        ],
      });

    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [
        { bank_account: 'A', month_start: '2025-04-01', amount_eur: 1000 },
        { bank_account: 'A', month_start: '2025-03-01', amount_eur: 900 },
        { bank_account: 'B', month_start: '2025-04-01', amount_eur: 500 },
      ],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.history.A).toEqual([
      { month: '2025-03', balance: 900 },
      { month: '2025-04', balance: 1000 },
    ]);
    expect(r.history.B).toEqual([{ month: '2025-04', balance: 500 }]);
  });

  it('aggregates total_history by summing balances across all banks per month', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [
        { bank_account: 'A', month_start: '2025-04-01', amount_eur: 1000 },
        { bank_account: 'B', month_start: '2025-04-01', amount_eur: 500 },
        { bank_account: 'A', month_start: '2025-03-01', amount_eur: 900 },
      ],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.total_history).toEqual([
      { month: '2025-03', balance: 900 },
      { month: '2025-04', balance: 1500 },
    ]);
  });

  it('formats Date month_start as YYYY-MM-DD then truncates to YYYY-MM', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([
      [],
      [{ bank_account: 'A', month_start: new Date('2025-04-01T00:00:00Z'), amount_eur: 100 }],
    ]);

    const r = await banksRepository.getBankBalances();
    expect(r.history.A[0].month).toBe('2025-04');
  });

  it('drops history rows missing a bank_account', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ bank_account: null, month_start: '2025-04-01', currency: 'EUR', balance: '100' }],
      });
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);

    const r = await banksRepository.getBankBalances();
    expect(r.history).toEqual({});
  });

  it('runs the two queries in parallel', async () => {
    let resolveCurrent;
    let resolveHistory;
    query
      .mockImplementationOnce(() => new Promise((r) => { resolveCurrent = () => r({ rows: [] }); }))
      .mockImplementationOnce(() => new Promise((r) => { resolveHistory = () => r({ rows: [] }); }));
    batchConvertGroupsWithHistoricalRateFallback.mockResolvedValueOnce([[], []]);

    const p = banksRepository.getBankBalances();
    expect(query).toHaveBeenCalledTimes(2); // both fired before either resolves
    resolveCurrent();
    resolveHistory();
    await p;
  });
});
