import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repositories/transactionRepository.js', () => ({
  transactionRepository: {
    getAll: vi.fn(),
    getUncategorised: vi.fn(),
  },
}));

import { transactionRepository } from '../src/repositories/transactionRepository.js';
import {
  getMonthlyCategoryBreakdown,
  searchTransactions,
  getLargestTransactions,
  getSpendTrendForCategory,
  getYearOverYearComparison,
  getUncategorisedTransactions,
  getNetCashflow,
} from '../src/services/aiChat/tools/expenses.js';

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());

describe('getMonthlyCategoryBreakdown', () => {
  it('groups by month then top-N categories per month', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-100', category_name: 'Food', date: '2025-01-05' },
      { amount: '-50', category_name: 'Transport', date: '2025-01-10' },
      { amount: '-30', category_name: 'Food', date: '2025-01-20' },
      { amount: '-200', category_name: 'Rent', date: '2025-02-01' },
      { amount: '50', category_name: 'Salary', date: '2025-01-25' }, // income skip
    ]);

    const r = await getMonthlyCategoryBreakdown.run({ from: '2025-01-01', to: '2025-02-28', topN: 5 });
    expect(r.data).toEqual([
      { month: '2025-01', category: 'Food', total: 130, count: 2 },
      { month: '2025-01', category: 'Transport', total: 50, count: 1 },
      { month: '2025-02', category: 'Rent', total: 200, count: 1 },
    ]);
  });

  it('respects topN cap per month', async () => {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push({ amount: `-${100 - i}`, category_name: `C${i}`, date: '2025-01-15' });
    transactionRepository.getAll.mockResolvedValueOnce(rows);

    const r = await getMonthlyCategoryBreakdown.run({ from: '2025-01-01', to: '2025-01-31', topN: 3 });
    expect(r.data).toHaveLength(3);
    expect(r.data[0].category).toBe('C0');
    expect(r.data[2].category).toBe('C2');
  });

  it('uses Uncategorised for null category names', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-10', category_name: null, date: '2025-01-15' },
    ]);
    const r = await getMonthlyCategoryBreakdown.run({ from: '2025-01-01', to: '2025-01-31' });
    expect(r.data[0].category).toBe('Uncategorised');
  });

  it('rejects invalid date order', async () => {
    await expect(getMonthlyCategoryBreakdown.run({ from: '2025-12-01', to: '2025-01-01' })).rejects.toThrow(/from/);
  });
});

describe('searchTransactions', () => {
  it('forwards trimmed query to repository search', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);
    await searchTransactions.run({ query: '  Netflix  ' });
    expect(transactionRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({ search: 'Netflix', active: true }));
  });

  it('rejects empty/whitespace query', async () => {
    await expect(searchTransactions.run({ query: '' })).rejects.toThrow(/query/);
    await expect(searchTransactions.run({ query: '   ' })).rejects.toThrow(/query/);
  });

  it('shapes result rows into table format', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { id: 5, amount: '-12.99', date: new Date('2025-04-15T05:00:00Z'), recipient_name: 'Spotify', category_name: 'Entertainment', memo: 'monthly' },
    ]);
    const r = await searchTransactions.run({ query: 'Spotify' });
    expect(r.data[0]).toEqual({
      id: 5,
      date: '2025-04-15',
      amount: -12.99,
      recipient: 'Spotify',
      category: 'Entertainment',
      memo: 'monthly',
    });
  });

  it('respects limit parameter and caps at 200', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);
    await searchTransactions.run({ query: 'x', limit: 5 });
    expect(transactionRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({ limit: 5 }));
    await expect(searchTransactions.run({ query: 'x', limit: 999 })).rejects.toThrow(/limit/);
  });

  it('passes optional date filters', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);
    await searchTransactions.run({ query: 'x', from: '2025-01-01', to: '2025-12-31' });
    expect(transactionRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({ startDate: '2025-01-01', endDate: '2025-12-31' }));
  });

  it('uses fallback labels when recipient/category missing', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { id: 1, amount: '-1', date: '2025-01-01', recipient_name: null, category_name: null, memo: null },
    ]);
    const r = await searchTransactions.run({ query: 'x' });
    expect(r.data[0]).toMatchObject({ recipient: 'Unknown', category: 'Uncategorised', memo: '' });
  });
});

describe('getLargestTransactions', () => {
  function fixtureRows() {
    return [
      { id: 1, amount: '-1500.00', date: '2025-04-01', recipient_name: 'Rent', category_name: 'Bills', memo: '' },
      { id: 2, amount: '-50.00', date: '2025-04-02', recipient_name: 'Coffee', category_name: 'Food', memo: '' },
      { id: 3, amount: '500.00', date: '2025-04-03', recipient_name: 'Salary', category_name: 'Income', memo: '' },
      { id: 4, amount: '-200.00', date: '2025-04-04', recipient_name: 'Insurance', category_name: 'Bills', memo: '' },
    ];
  }

  it('defaults to expense direction', async () => {
    transactionRepository.getAll.mockResolvedValueOnce(fixtureRows());
    const r = await getLargestTransactions.run({ from: '2025-04-01', to: '2025-04-30' });
    expect(r.data.map((t) => t.id)).toEqual([1, 4, 2]);
    expect(r.meta.direction).toBe('expense');
  });

  it('returns income-only when direction=income', async () => {
    transactionRepository.getAll.mockResolvedValueOnce(fixtureRows());
    const r = await getLargestTransactions.run({ from: '2025-04-01', to: '2025-04-30', direction: 'income' });
    expect(r.data).toHaveLength(1);
    expect(r.data[0].id).toBe(3);
  });

  it('returns both directions when direction=both, sorted by abs amount', async () => {
    transactionRepository.getAll.mockResolvedValueOnce(fixtureRows());
    const r = await getLargestTransactions.run({ from: '2025-04-01', to: '2025-04-30', direction: 'both' });
    expect(r.data.map((t) => t.id)).toEqual([1, 3, 4, 2]);
  });

  it('strips absAmount internal field from output', async () => {
    transactionRepository.getAll.mockResolvedValueOnce(fixtureRows());
    const r = await getLargestTransactions.run({ from: '2025-04-01', to: '2025-04-30' });
    expect(r.data[0]).not.toHaveProperty('absAmount');
  });

  it('respects topN', async () => {
    transactionRepository.getAll.mockResolvedValueOnce(fixtureRows());
    const r = await getLargestTransactions.run({ from: '2025-04-01', to: '2025-04-30', topN: 1 });
    expect(r.data).toHaveLength(1);
  });
});

describe('getSpendTrendForCategory', () => {
  it('rejects out-of-range categoryId', async () => {
    await expect(getSpendTrendForCategory.run({ categoryId: 0 })).rejects.toThrow(/categoryId/);
    await expect(getSpendTrendForCategory.run({ categoryId: -1 })).rejects.toThrow(/categoryId/);
  });

  it('passes categoryId filter to repository', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);
    await getSpendTrendForCategory.run({ categoryId: 7, months: 6 });
    expect(transactionRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 7 }));
  });

  it('groups spending by month, ignoring income rows', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-100', date: '2025-01-15' },
      { amount: '-50', date: '2025-01-25' },
      { amount: '50', date: '2025-01-30' }, // income skip
      { amount: '-200', date: '2025-02-10' },
    ]);
    const r = await getSpendTrendForCategory.run({ categoryId: 1 });
    expect(r.data).toEqual([
      { bucket: '2025-01', total: 150, count: 2 },
      { bucket: '2025-02', total: 200, count: 1 },
    ]);
  });

  it('caps months at 36', async () => {
    await expect(getSpendTrendForCategory.run({ categoryId: 1, months: 999 })).rejects.toThrow(/months/);
  });

  it('uses defaults when months omitted', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);
    const r = await getSpendTrendForCategory.run({ categoryId: 1 });
    expect(r.meta.months).toBe(12);
  });
});

describe('getYearOverYearComparison', () => {
  it('defaults prevYear to year - 1', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);
    transactionRepository.getAll.mockResolvedValueOnce([]);
    const r = await getYearOverYearComparison.run({ year: 2025 });
    expect(r.meta.prevYear).toBe(2024);
  });

  it('computes delta and pctChange per category', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-200', category_name: 'Food', date: '2025-04-01' },
    ]);
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-100', category_name: 'Food', date: '2024-04-01' },
    ]);
    const r = await getYearOverYearComparison.run({ year: 2025 });
    expect(r.data[0]).toEqual({
      category: 'Food',
      '2025': 200,
      '2024': 100,
      delta: 100,
      pctChange: 100,
    });
  });

  it('sets pctChange to null when previous year had zero', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([{ amount: '-50', category_name: 'New', date: '2025-04-01' }]);
    transactionRepository.getAll.mockResolvedValueOnce([]);
    const r = await getYearOverYearComparison.run({ year: 2025 });
    expect(r.data[0].pctChange).toBeNull();
  });

  it('sorts categories by current-year spend descending', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '-50', category_name: 'A', date: '2025-04-01' },
      { amount: '-200', category_name: 'B', date: '2025-04-01' },
    ]);
    transactionRepository.getAll.mockResolvedValueOnce([]);
    const r = await getYearOverYearComparison.run({ year: 2025 });
    expect(r.data.map((d) => d.category)).toEqual(['B', 'A']);
  });

  it('runs both year fetches in parallel', async () => {
    let resolveCurrent;
    let resolvePrev;
    transactionRepository.getAll
      .mockImplementationOnce(() => new Promise((r) => { resolveCurrent = () => r([]); }))
      .mockImplementationOnce(() => new Promise((r) => { resolvePrev = () => r([]); }));

    const p = getYearOverYearComparison.run({ year: 2025 });
    expect(transactionRepository.getAll).toHaveBeenCalledTimes(2);
    resolveCurrent();
    resolvePrev();
    await p;
  });
});

describe('getUncategorisedTransactions', () => {
  it('uses repository.getUncategorised', async () => {
    transactionRepository.getUncategorised.mockResolvedValueOnce([
      { id: 1, amount: '-10', date: '2025-04-01', recipient_name: 'X', memo: 'm' },
    ]);
    const r = await getUncategorisedTransactions.run({});
    expect(transactionRepository.getUncategorised).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    expect(r.data[0]).toMatchObject({ id: 1, amount: -10, recipient: 'X' });
  });

  it('respects custom limit (max 200)', async () => {
    transactionRepository.getUncategorised.mockResolvedValueOnce([]);
    await getUncategorisedTransactions.run({ limit: 100 });
    expect(transactionRepository.getUncategorised).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    await expect(getUncategorisedTransactions.run({ limit: 999 })).rejects.toThrow(/limit/);
  });
});

describe('getNetCashflow', () => {
  it('groups income/expenses by month with totals', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '500', date: '2025-04-01' },
      { amount: '-200', date: '2025-04-15' },
      { amount: '600', date: '2025-05-01' },
    ]);
    const r = await getNetCashflow.run({ from: '2025-04-01', to: '2025-05-31' });
    expect(r.data).toEqual([
      { period: '2025-04', income: 500, expenses: 200, net: 300 },
      { period: '2025-05', income: 600, expenses: 0, net: 600 },
    ]);
    expect(r.meta).toMatchObject({
      totalIncome: 1100,
      totalExpenses: 200,
      totalNet: 900,
    });
  });

  it('groups by quarter when groupBy=quarter', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: '500', date: '2025-01-15' }, // Q1
      { amount: '-200', date: '2025-04-15' }, // Q2
      { amount: '300', date: '2025-09-01' }, // Q3
    ]);
    const r = await getNetCashflow.run({ from: '2025-01-01', to: '2025-12-31', groupBy: 'quarter' });
    expect(r.data.map((d) => d.period)).toEqual(['2025-Q1', '2025-Q2', '2025-Q3']);
  });

  it('rejects invalid groupBy', async () => {
    await expect(getNetCashflow.run({ from: '2025-01-01', to: '2025-12-31', groupBy: 'weekly' })).rejects.toThrow(/groupBy/);
  });

  it('handles null amount as zero', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { amount: null, date: '2025-01-01' },
    ]);
    const r = await getNetCashflow.run({ from: '2025-01-01', to: '2025-01-31' });
    expect(r.data[0]).toMatchObject({ income: 0, expenses: 0, net: 0 });
  });
});
