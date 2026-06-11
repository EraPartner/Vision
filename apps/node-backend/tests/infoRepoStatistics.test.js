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
    // The repo now converts two legs (income/expense) per grouped row; cnt is the
    // group's transaction count, counted once on the income leg.
    convertRowsToEur.mockResolvedValueOnce([
      { period: '2025-04', category_id: 1, category_name: 'Food', _leg: 'income', cnt: 1, amount_eur: 0 },
      { period: '2025-04', category_id: 1, category_name: 'Food', _leg: 'expense', cnt: 1, amount_eur: -100 },
      { period: '2025-04', category_id: 2, category_name: 'Bills', _leg: 'income', cnt: 1, amount_eur: 0 },
      { period: '2025-04', category_id: 2, category_name: 'Bills', _leg: 'expense', cnt: 1, amount_eur: -500 },
      { period: '2025-04', category_id: 1, category_name: 'Food', _leg: 'income', cnt: 1, amount_eur: 0 },
      { period: '2025-04', category_id: 1, category_name: 'Food', _leg: 'expense', cnt: 1, amount_eur: -50 },
    ]);

    const r = await statisticsRepository.getCategoryPivot();
    expect(r.categoryPivot['2025-04']).toEqual([
      { categoryId: 2, categoryName: 'Bills', total: -500, income: 0, expense: -500, transactionCount: 1 },
      { categoryId: 1, categoryName: 'Food', total: -150, income: 0, expense: -150, transactionCount: 2 },
    ]);
  });

  it('reports explicit income/expense for a mixed-sign category-month', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([
      { period: '2025-04', category_id: 1, category_name: 'Food', _leg: 'income', cnt: 2, amount_eur: 500 },
      { period: '2025-04', category_id: 1, category_name: 'Food', _leg: 'expense', cnt: 2, amount_eur: -300 },
    ]);
    const r = await statisticsRepository.getCategoryPivot();
    // Net +200, but income (500) and expense (-300) are reported separately so
    // consumers don't have to misclassify by the sign of the net.
    expect(r.categoryPivot['2025-04'][0]).toEqual({
      categoryId: 1, categoryName: 'Food', total: 200, income: 500, expense: -300, transactionCount: 2,
    });
  });

  it('binds category and recipient exclusions', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    convertRowsToEur.mockResolvedValueOnce([]);
    await statisticsRepository.getCategoryPivot([1, 2], 'EUR', [9]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('NOT IN ($1,$2)');
    expect(sql).toContain('NOT IN ($3)');
    expect(params).toEqual([1, 2, 9]);
    // Canonical semantics: 3-level category COALESCE + alias-aware recipient
    // exclusion (was 2-level category + bare t.recipient_id NOT IN, which
    // disagreed with the dashboard/forecast on merged recipients).
    expect(sql).toContain('COALESCE(t.category_id, r.default_category_id, pr.default_category_id) NOT IN');
    expect(sql).toContain('COALESCE(r.primary_recipient_id, t.recipient_id) NOT IN');
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
      { period: '2025-04', category_id: null, category_name: null, _leg: 'income', cnt: 1, amount_eur: 0 },
      { period: '2025-04', category_id: null, category_name: null, _leg: 'expense', cnt: 1, amount_eur: -10 },
    ]);
    const r = await statisticsRepository.getCategoryPivot();
    expect(r.categoryPivot['2025-04'][0]).toMatchObject({
      categoryId: null,
      categoryName: 'Uncategorised',
    });
  });
});

