import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../src/services/currency/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(),
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/repositories/infoRepositoryHelpers.js', async () => {
  const actual = await vi.importActual('../src/repositories/infoRepositoryHelpers.js');
  return { ...actual, mvAvailable: vi.fn(), clearMvCache: actual.clearMvCache };
});

import { query } from '../src/database/connection.js';
import { convertRowsToEur } from '../src/services/currency/currencyConversionService.js';
import { mvAvailable } from '../src/repositories/infoRepositoryHelpers.js';
import { getMonthlyFinancialSummary } from '../src/repositories/infoRepo.monthly.js';

beforeEach(() => vi.clearAllMocks());

describe('getMonthlyFinancialSummary — materialized-view fast path', () => {
  it('uses mv_monthly_summary when no exclusions and not allTime', async () => {
    mvAvailable.mockResolvedValueOnce(true);

    query.mockResolvedValueOnce({
      rows: [
        {
          month_start: new Date('2025-04-01T00:00:00Z'),
          month: 4,
          year: 2025,
          currency: 'EUR',
          transaction_count: '10',
          total_income: '1000',
          total_spending: '-400',
          net_amount: '600',
        },
      ],
    });

    convertRowsToEur.mockResolvedValueOnce([
      { _key: '2025-04', _type: 'income', _row: { month: 4, year: 2025, month_start: new Date('2025-04-01T00:00:00Z'), transaction_count: '10' }, amount_eur: 1000 },
      { _key: '2025-04', _type: 'spending', _row: { month: 4, year: 2025, month_start: new Date('2025-04-01T00:00:00Z'), transaction_count: '10' }, amount_eur: -400 },
    ]);

    const r = await getMonthlyFinancialSummary([], 'EUR', [], false);

    expect(query.mock.calls[0][0]).toContain('FROM mv_monthly_summary');
    expect(r.months).toHaveLength(1);
    expect(r.months[0]).toMatchObject({
      month: 4,
      year: 2025,
      total_income: 1000,
      total_spending: -400,
      net_amount: 600,
      transaction_count: 10, // halved (income+spending counted once each)
    });
    expect(r.summary).toBeDefined();
  });

  it('falls through to live query when mv unavailable', async () => {
    mvAvailable.mockResolvedValueOnce(false);
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([], 'EUR', [], false);

    expect(query.mock.calls[0][0]).toContain('generate_series');
    expect(query.mock.calls[0][0]).toContain('filtered_transactions');
  });

  it('always uses live query when category exclusions present', async () => {
    mvAvailable.mockResolvedValue(true); // would skip mv-path for excluded ids
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([5, 7], 'EUR', [], false);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('NOT IN ($1,$2)');
    expect(params).toEqual([5, 7]);
  });

  it('always uses live query when recipient exclusions present', async () => {
    mvAvailable.mockResolvedValue(true);
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([], 'EUR', [3, 4], false);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual([3, 4]);
  });

  it('combines category and recipient exclusions with sequential param numbering', async () => {
    mvAvailable.mockResolvedValue(true);
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([1], 'EUR', [99], false);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/category.*\$1/);
    expect(sql).toMatch(/recipient_id NOT IN \(\$2\)/);
    expect(params).toEqual([1, 99]);
  });

  it('drops invalid IDs from exclusion lists', async () => {
    mvAvailable.mockResolvedValue(true);
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary(
      [0, -1, 1.5, 'evil', 2147483647, 99],
      'EUR',
      [null, undefined, 5],
      false,
    );

    const [, params] = query.mock.calls[0];
    expect(params).toEqual([99, 5]);
  });

  it('uses earliest-transaction date when allTime=true', async () => {
    mvAvailable.mockResolvedValue(false);
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);

    await getMonthlyFinancialSummary([], 'EUR', [], true);

    const [sql] = query.mock.calls[0];
    expect(sql).toContain('SELECT MIN(date_trunc');
  });

  it('groups live transactions into income vs spending buckets', async () => {
    mvAvailable.mockResolvedValueOnce(false);

    query.mockResolvedValueOnce({
      rows: [
        { txn_id: 1, month: 4, year: 2025, period_start: '2025-04-01', period_end: '2025-04-30', amount: '500', currency: 'EUR', date: '2025-04-05' },
        { txn_id: 2, month: 4, year: 2025, period_start: '2025-04-01', period_end: '2025-04-30', amount: '-100', currency: 'EUR', date: '2025-04-10' },
        { txn_id: 3, month: 4, year: 2025, period_start: '2025-04-01', period_end: '2025-04-30', amount: '-50', currency: 'EUR', date: '2025-04-15' },
        // Empty placeholder month with no txn (txn_id null) — filtered before convert.
        { txn_id: null, month: 5, year: 2025, period_start: '2025-05-01', period_end: '2025-05-31', amount: null, currency: null, date: null },
      ],
    });

    convertRowsToEur.mockResolvedValueOnce([
      { month: 4, year: 2025, amount_eur: 500 },
      { month: 4, year: 2025, amount_eur: -100 },
      { month: 4, year: 2025, amount_eur: -50 },
    ]);

    const r = await getMonthlyFinancialSummary([], 'EUR', [], false);
    const apr = r.months.find((m) => m.month === 4);
    expect(apr).toMatchObject({
      total_income: 500,
      total_spending: -150,
      net_amount: 350,
      transaction_count: 3,
    });
    const may = r.months.find((m) => m.month === 5);
    expect(may).toMatchObject({
      total_income: 0,
      total_spending: 0,
      net_amount: 0,
      transaction_count: 0,
    });
  });
});
