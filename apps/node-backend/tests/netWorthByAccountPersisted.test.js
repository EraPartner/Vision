import { describe, it, expect, vi, beforeEach } from 'vitest';

import { mockLogger } from './helpers/mockLogger.js';
// getNetWorthByAccount should read the persisted per-account split (migration
// 0074) rather than replaying the full computeDailySnapshots day-walk, and fall
// back to the replay only when the side table is missing or empty.
vi.mock('../src/database/connection.js', () => ({ query: vi.fn() }));

vi.mock('../src/config/logger.js', () => ({
  logger: mockLogger(),
}));

vi.mock('../src/services/portfolio/snapshotBuilder.js', () => ({
  computeDailySnapshots: vi.fn(async () => []),
}));

vi.mock('../src/repositories/accountRepository.js', () => ({
  accountRepository: { getAll: vi.fn() },
}));

vi.mock('../src/services/currency/currencyConversionService.js', () => ({
  convertToCurrency: vi.fn(async (amount) => amount),
}));

import { query } from '../src/database/connection.js';
import { computeDailySnapshots } from '../src/services/portfolio/snapshotBuilder.js';
import { accountRepository } from '../src/repositories/accountRepository.js';
import { netWorthRepository } from '../src/repositories/infoRepositoryNetWorth.js';

beforeEach(() => vi.clearAllMocks());

function routeReads({ tableExists, splitRows }) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('information_schema.tables') && sql.includes("portfolio_snapshot_accounts")) {
      return { rows: tableExists ? [{}] : [] };
    }
    if (sql.includes('FROM portfolio_snapshot_accounts')) {
      return { rows: splitRows };
    }
    return { rows: [] };
  });
}

describe('getNetWorthByAccount reads the persisted split', () => {
  it('builds rows from portfolio_snapshot_accounts without replaying the day-walk', async () => {
    routeReads({
      tableExists: true,
      splitRows: [
        { day: '2026-07-09', account_key: '10', value: '90.00' },
        { day: '2026-07-10', account_key: '10', value: '100.00' },
        { day: '2026-07-10', account_key: 'unassigned', value: '25.00' },
      ],
    });
    accountRepository.getAll.mockResolvedValue([
      { id: 10, name: 'Broker', display_name: 'Broker', currency: 'EUR', computed_balance: 50, in_net_worth: true },
    ]);

    const result = await netWorthRepository.getNetWorthByAccount('EUR');

    // The persisted path must NOT trigger a full recompute.
    expect(computeDailySnapshots).not.toHaveBeenCalled();

    const acct10 = result.accounts.find((r) => r.accountId === 10);
    expect(acct10).toBeDefined();
    expect(acct10.cash).toBeCloseTo(50, 2);
    expect(acct10.currentHoldings).toBeCloseTo(100, 2); // latest persisted point
    expect(acct10.currentTotal).toBeCloseTo(150, 2);
    expect(acct10.holdingsSeries.map((p) => p.holdings)).toEqual([90, 100]);

    // Legacy unassigned lots surface as an accountId: null holdings-only row.
    const unassigned = result.accounts.find((r) => r.accountId === null);
    expect(unassigned).toBeDefined();
    expect(unassigned.currentHoldings).toBeCloseTo(25, 2);
    expect(unassigned.cash).toBe(0);
  });

  it('falls back to a live replay when the side table is empty', async () => {
    routeReads({ tableExists: true, splitRows: [] });
    accountRepository.getAll.mockResolvedValue([
      { id: 10, name: 'Broker', display_name: 'Broker', currency: 'EUR', computed_balance: 50, in_net_worth: true },
    ]);

    await netWorthRepository.getNetWorthByAccount('EUR');
    expect(computeDailySnapshots).toHaveBeenCalledTimes(1);
  });

  it('falls back to a live replay when the side table is absent (un-migrated DB)', async () => {
    routeReads({ tableExists: false, splitRows: [] });
    accountRepository.getAll.mockResolvedValue([]);

    await netWorthRepository.getNetWorthByAccount('EUR');
    expect(computeDailySnapshots).toHaveBeenCalledTimes(1);
  });
});
