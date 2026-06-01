import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/database/connection.js', () => ({
  query: vi.fn(),
  queryPrepared: vi.fn(),
}));

vi.mock('../src/services/currency/currencyConversionService.js', () => ({
  convertRowsToEur: vi.fn(),
}));

vi.mock('../src/repositories/infoRepositoryHelpers.js', async () => {
  const actual = await vi.importActual('../src/repositories/infoRepositoryHelpers.js');
  return { ...actual, mvAvailable: vi.fn() };
});

import { query, queryPrepared } from '../src/database/connection.js';
import { convertRowsToEur } from '../src/services/currency/currencyConversionService.js';
import { mvAvailable } from '../src/repositories/infoRepositoryHelpers.js';
import { statisticsRepository } from '../src/repositories/infoRepositoryStatistics.js';

beforeEach(() => vi.clearAllMocks());

describe('statisticsRepository.getStatistics', () => {
  it('uses materialized view when available', async () => {
    mvAvailable.mockResolvedValueOnce(true);
    query
      .mockResolvedValueOnce({ rows: [{ count: '42' }] })
      .mockResolvedValueOnce({ rows: [{ category_id: 1, name: 'Food', count: 5, total: '100' }] });
    convertRowsToEur.mockResolvedValueOnce([
      { category_id: 1, name: 'Food', count: 5, amount_eur: 100 },
    ]);

    const r = await statisticsRepository.getStatistics();
    expect(r.total_transactions).toBe(42);
    expect(r.categories).toHaveLength(1);
    expect(query.mock.calls[1][0]).toContain('FROM mv_category_totals');
  });

  it('falls back to live query when MV unavailable', async () => {
    mvAvailable.mockResolvedValueOnce(false);
    query
      .mockResolvedValueOnce({ rows: [{ count: '10' }] })
      .mockResolvedValueOnce({
        rows: [
          { category_id: 1, name: 'Food', amount: '-50', currency: 'EUR', date: '2025-04-01' },
          { category_id: 1, name: 'Food', amount: '-30', currency: 'EUR', date: '2025-04-02' },
          { category_id: -1, name: 'UNCATEGORISED', amount: '-10', currency: 'EUR', date: '2025-04-03' },
        ],
      });
    convertRowsToEur.mockResolvedValueOnce([
      { category_id: 1, name: 'Food', amount_eur: -50 },
      { category_id: 1, name: 'Food', amount_eur: -30 },
      { category_id: -1, name: 'UNCATEGORISED', amount_eur: -10 },
    ]);

    const r = await statisticsRepository.getStatistics();
    expect(r.total_transactions).toBe(10);
    // total_amount is derived from the same converted category rows: -50 + -30 + -10
    expect(r.total_amount).toBe(-90);
    const food = r.categories.find((c) => c.id === 1);
    expect(food).toMatchObject({ id: 1, name: 'Food', count: 2, total: -80 });
    const uncat = r.categories.find((c) => c.id === null);
    expect(uncat).toMatchObject({ id: null, count: 1, total: -10 });
  });
});

describe('statisticsRepository.getCategoryBreakdown', () => {
  it('uses MV when available', async () => {
    mvAvailable.mockResolvedValueOnce(true);
    query.mockResolvedValueOnce({ rows: [{ category_id: 1, name: 'Food', count: 5, total: '100' }] });
    convertRowsToEur.mockResolvedValueOnce([
      { category_id: 1, name: 'Food', count: 5, amount_eur: 100 },
    ]);
    const r = await statisticsRepository.getCategoryBreakdown();
    expect(r).toHaveLength(1);
    expect(query.mock.calls[0][0]).toContain('mv_category_totals');
  });

  it('groups categories from live query and sorts by count desc', async () => {
    mvAvailable.mockResolvedValueOnce(false);
    query.mockResolvedValueOnce({
      rows: [
        { category_id: 1, name: 'A', amount: '-10' },
        { category_id: 1, name: 'A', amount: '-20' },
        { category_id: 2, name: 'B', amount: '-50' },
      ],
    });
    convertRowsToEur.mockResolvedValueOnce([
      { category_id: 1, name: 'A', amount_eur: -10 },
      { category_id: 1, name: 'A', amount_eur: -20 },
      { category_id: 2, name: 'B', amount_eur: -50 },
    ]);

    const r = await statisticsRepository.getCategoryBreakdown();
    expect(r[0]).toMatchObject({ id: 1, count: 2, total: -30 });
    expect(r[1]).toMatchObject({ id: 2, count: 1, total: -50 });
  });
});

describe('statisticsRepository.getBanks', () => {
  it('returns distinct bank_account values via prepared query', async () => {
    queryPrepared.mockResolvedValueOnce({
      rows: [{ bank_account: 'BANK_A' }, { bank_account: 'BANK_B' }],
    });
    const r = await statisticsRepository.getBanks();
    expect(r).toEqual(['BANK_A', 'BANK_B']);
    expect(queryPrepared).toHaveBeenCalledWith(
      'info_get_banks',
      expect.stringContaining('SELECT DISTINCT bank_account'),
      [],
    );
  });
});

describe('statisticsRepository.getTransactionCount', () => {
  it('parses integer count from prepared query', async () => {
    queryPrepared.mockResolvedValueOnce({ rows: [{ count: '5000' }] });
    expect(await statisticsRepository.getTransactionCount()).toBe(5000);
  });
});

describe('statisticsRepository.getCategoryPivot', () => {
  it('groups by period and category, sorts ascending by total', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([
      { period: '2025-04', category_id: 1, category_name: 'Food', amount_eur: -100 },
      { period: '2025-04', category_id: 2, category_name: 'Bills', amount_eur: -500 },
      { period: '2025-04', category_id: 1, category_name: 'Food', amount_eur: -50 },
    ]);

    const r = await statisticsRepository.getCategoryPivot();
    expect(r.categoryPivot['2025-04']).toEqual([
      { categoryId: 2, categoryName: 'Bills', total: -500, transactionCount: 1 },
      { categoryId: 1, categoryName: 'Food', total: -150, transactionCount: 2 },
    ]);
  });

  it('binds category and recipient exclusions', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await statisticsRepository.getCategoryPivot([1, 2], 'EUR', [9]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('NOT IN ($1,$2)');
    expect(sql).toContain('NOT IN ($3)');
    expect(params).toEqual([1, 2, 9]);
  });

  it('drops invalid IDs from exclusion lists', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await statisticsRepository.getCategoryPivot(
      [0, -1, 'evil', 1.5, 2147483647, 5],
      'EUR',
      [null, undefined, 7],
    );
    const params = query.mock.calls[0][1];
    expect(params).toEqual([5, 7]);
  });

  it('treats missing category_id as Uncategorised', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([
      { period: '2025-04', category_id: null, category_name: null, amount_eur: -10 },
    ]);
    const r = await statisticsRepository.getCategoryPivot();
    expect(r.categoryPivot['2025-04'][0]).toMatchObject({
      categoryId: null,
      categoryName: 'Uncategorised',
    });
  });
});

describe('statisticsRepository.getTransactionSummary', () => {
  it('returns zeros when no rows match filters', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const r = await statisticsRepository.getTransactionSummary({ bankAccount: 'XYZ' });
    expect(r).toEqual({
      total_count: 0,
      total_amount: 0,
      average: 0,
      min: null,
      max: null,
    });
    expect(convertRowsToEur).not.toHaveBeenCalled();
  });

  it('combines per-currency grouped aggregates after FX conversion', async () => {
    // SQL now returns one row per currency. EUR: 2 txns; USD: 1 txn @ rate 0.9.
    query.mockResolvedValueOnce({
      rows: [
        { currency: 'EUR', cnt: '2', sum_amount: '250', min_amount: '-50', max_amount: '200' },
        { currency: 'USD', cnt: '1', sum_amount: '100', min_amount: '100', max_amount: '100' },
      ],
    });
    // Three convertRowsToEur calls (sum, then min, then max), each [EUR, USD].
    convertRowsToEur
      .mockResolvedValueOnce([{ amount_eur: 250 }, { amount_eur: 90 }]) // sum: 250 + 90 = 340
      .mockResolvedValueOnce([{ amount_eur: -50 }, { amount_eur: 90 }]) // min over all = -50
      .mockResolvedValueOnce([{ amount_eur: 200 }, { amount_eur: 90 }]); // max over all = 200

    const r = await statisticsRepository.getTransactionSummary();
    expect(convertRowsToEur).toHaveBeenCalledTimes(3);
    expect(r).toEqual({
      total_count: 3,        // 2 + 1
      total_amount: 340,     // 250 + 90
      average: 113.33,       // 340 / 3
      min: -50,
      max: 200,
    });
  });

  it('aggregates in SQL grouped by currency', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await statisticsRepository.getTransactionSummary();
    const [sql] = query.mock.calls[0];
    expect(sql).toContain('GROUP BY t.currency');
    expect(sql).toContain('SUM(t.amount)');
    expect(sql).toContain('MIN(t.amount)');
    expect(sql).toContain('MAX(t.amount)');
    expect(sql).toContain('COUNT(*)');
  });

  it('applies bankAccount, startDate, endDate filters in SQL', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await statisticsRepository.getTransactionSummary({
      bankAccount: 'A1',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('bank_account ILIKE $1');
    expect(sql).toContain('t.date >= $2');
    expect(sql).toContain('t.date <= $3');
    expect(params).toEqual(['%A1%', '2025-01-01', '2025-12-31']);
  });

  it('handles only some filters', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await statisticsRepository.getTransactionSummary({ startDate: '2025-04-01' });
    const params = query.mock.calls[0][1];
    expect(params).toEqual(['2025-04-01']);
  });
});
