import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/repositories/infoRepository.js', () => ({
  infoRepository: {
    getBankBalances: vi.fn(),
    getAverageVsCurrentSpending: vi.fn(),
  },
}));

vi.mock('../src/repositories/watchlistRepository.js', () => ({
  watchlistRepository: {
    getAllWithCount: vi.fn(),
  },
}));

vi.mock('../src/repositories/categoryRepository.js', () => ({
  categoryRepository: {
    getAll: vi.fn(),
  },
}));

vi.mock('../src/repositories/transactionRepository.js', () => ({
  transactionRepository: {
    getAll: vi.fn(),
  },
}));

vi.mock('../src/services/recurringDetectionService.js', () => ({
  detectRecurringPatterns: vi.fn(),
}));

import { infoRepository } from '../src/repositories/infoRepository.js';
import { watchlistRepository } from '../src/repositories/watchlistRepository.js';
import { categoryRepository } from '../src/repositories/categoryRepository.js';
import { transactionRepository } from '../src/repositories/transactionRepository.js';
import { detectRecurringPatterns } from '../src/services/recurringDetectionService.js';
import {
  getBankBalances,
  getSpendingPace,
  getRecipientInsights,
  getWatchlist,
  getCategories,
  getRecurringDetected,
} from '../src/services/aiChat/tools/insights.js';

beforeEach(() => vi.resetAllMocks());

describe('getBankBalances', () => {
  it('reshapes accounts and totals into the tool envelope', async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({
      accounts: [
        { bank_account: 'A', balance: 1234.5, transaction_count: 10, first_transaction: '2025-01-02', last_transaction: '2025-04-01' },
      ],
      total_net_position: 1234.5,
    });

    const result = await getBankBalances.run({});

    expect(result.ok).toBe(true);
    expect(result.data).toEqual([
      { account: 'A', balance: 1234.5, currency: 'EUR', transactionCount: 10, firstTransaction: '2025-01-02', lastTransaction: '2025-04-01' },
    ]);
    expect(result.meta).toMatchObject({ totalNetPosition: 1234.5, accountCount: 1, currency: 'EUR', renderAs: 'table' });
  });

  it('coerces string/decimal balances to numbers (rounded to cents)', async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({
      accounts: [{ bank_account: 'X', balance: '99.999', transaction_count: 0, first_transaction: null, last_transaction: null }],
      total_net_position: '99.999',
    });
    const r = await getBankBalances.run({});
    expect(r.data[0].balance).toBe(100);
    expect(r.meta.totalNetPosition).toBe(100);
  });

  it('formats pg DATE-shaped Date instances to their stored calendar day', async () => {
    // pg returns DATE columns as local-midnight Dates; new Date(y, m, d) mirrors
    // that shape. toYmd's local getters recover the stored day in any server TZ —
    // the old toISOString() formatting shifted it one day back east of UTC.
    infoRepository.getBankBalances.mockResolvedValueOnce({
      accounts: [{ bank_account: 'B', balance: 0, transaction_count: 0, first_transaction: new Date(2024, 11, 31), last_transaction: new Date(2025, 5, 15) }],
      total_net_position: 0,
    });
    const r = await getBankBalances.run({});
    expect(r.data[0].firstTransaction).toBe('2024-12-31');
    expect(r.data[0].lastTransaction).toBe('2025-06-15');
  });

  it('handles missing accounts array', async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({});
    const r = await getBankBalances.run({});
    expect(r.data).toEqual([]);
    expect(r.meta.accountCount).toBe(0);
  });

  it('respects the maxRows context cap', async () => {
    infoRepository.getBankBalances.mockResolvedValueOnce({
      accounts: Array.from({ length: 5 }, (_, i) => ({ bank_account: `A${i}`, balance: 0, transaction_count: 0, first_transaction: null, last_transaction: null })),
      total_net_position: 0,
    });
    const r = await getBankBalances.run({}, { maxRows: 2 });
    expect(r.data).toHaveLength(2);
  });
});

describe('getSpendingPace', () => {
  function fixturePayload() {
    return {
      past_6_months: { avg_daily_spending: 15.5, avg_monthly_spending: 465, months_counted: 6 },
      current_month: { total_spending: 200, days_elapsed: 14, days_in_month: 30 },
      comparison: { projected_monthly_total: 428.57, pace: 'on_track', variance: -7.84 },
    };
  }

  it('defaults to monthly normalisation', async () => {
    infoRepository.getAverageVsCurrentSpending.mockResolvedValueOnce(fixturePayload());
    const r = await getSpendingPace.run({});
    expect(r.meta.period).toBe('monthly');
    expect(r.data.find((d) => d.label.includes('Avg monthly')).value).toBe(465);
    expect(r.data.find((d) => d.label.includes('Projected monthly')).value).toBe(428.57);
  });

  it('multiplies monthly figures by 12 for yearly normalisation', async () => {
    infoRepository.getAverageVsCurrentSpending.mockResolvedValueOnce(fixturePayload());
    const r = await getSpendingPace.run({ period: 'yearly' });
    expect(r.data.find((d) => d.label.includes('Avg yearly')).value).toBe(465 * 12);
    expect(r.data.find((d) => d.label.includes('Projected yearly')).value).toBe(428.57 * 12);
  });

  it('throws ToolValidationError on unknown period', async () => {
    await expect(getSpendingPace.run({ period: 'weekly' })).rejects.toThrow(/period must be one of/);
  });

  it('handles missing nested payloads with safe defaults', async () => {
    infoRepository.getAverageVsCurrentSpending.mockResolvedValueOnce({});
    const r = await getSpendingPace.run({});
    expect(r.ok).toBe(true);
    expect(r.data.every((d) => d.value === 0)).toBe(true);
    expect(r.meta.daysElapsed).toBeNull();
  });
});

describe('getRecipientInsights', () => {
  it('groups by recipient and sorts by count desc', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { recipient_name: 'Alice', recipient_id: 1, amount: '-10', date: '2025-01-01' },
      { recipient_name: 'Alice', recipient_id: 1, amount: '-30', date: '2025-02-15' },
      { recipient_name: 'Bob', recipient_id: 2, amount: '-50', date: '2025-03-01' },
      { recipient_name: 'Bob', recipient_id: 2, amount: '20', date: '2025-03-05' },
      { recipient_name: 'Bob', recipient_id: 2, amount: '-10', date: '2025-03-10' },
    ]);

    const r = await getRecipientInsights.run({});
    expect(r.data).toHaveLength(2);
    expect(r.data[0]).toEqual({ recipient: 'Bob', recipientId: 2, count: 3, totalSpend: 60, totalIncome: 20, avgSpend: 20, lastDate: '2025-03-10' });
    expect(r.data[1]).toEqual({ recipient: 'Alice', recipientId: 1, count: 2, totalSpend: 40, totalIncome: 0, avgSpend: 20, lastDate: '2025-02-15' });
  });

  it('skips rows without a recipient name', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { recipient_name: null, amount: '-10', date: '2025-01-01' },
      { recipient_name: '', amount: '-10', date: '2025-01-02' },
      { recipient_name: 'Alice', recipient_id: 1, amount: '-10', date: '2025-01-03' },
    ]);
    const r = await getRecipientInsights.run({});
    expect(r.data).toHaveLength(1);
    expect(r.data[0].recipient).toBe('Alice');
  });

  it('passes recipientId filter through to the repository', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([]);
    await getRecipientInsights.run({ recipientId: 7 });
    expect(transactionRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 7, active: true }));
  });

  it('truncates listing to limit when no recipientId given', async () => {
    transactionRepository.getAll.mockResolvedValueOnce(
      Array.from({ length: 10 }, (_, i) => ({ recipient_name: `R${i}`, recipient_id: i, amount: '-1', date: '2025-01-01' })),
    );
    const r = await getRecipientInsights.run({ limit: 3 });
    expect(r.data).toHaveLength(3);
  });

  it('returns all recipients when recipientId set, ignoring limit', async () => {
    transactionRepository.getAll.mockResolvedValueOnce(
      Array.from({ length: 4 }, (_, i) => ({ recipient_name: `R${i}`, recipient_id: i + 1, amount: '-1', date: '2025-01-01' })),
    );
    const r = await getRecipientInsights.run({ recipientId: 1, limit: 1 });
    expect(r.data.length).toBeGreaterThan(1);
  });

  it('parses Date date columns', async () => {
    transactionRepository.getAll.mockResolvedValueOnce([
      { recipient_name: 'X', recipient_id: 1, amount: '-1', date: new Date('2025-05-08T12:00:00Z') },
    ]);
    const r = await getRecipientInsights.run({});
    expect(r.data[0].lastDate).toBe('2025-05-08');
  });

  it('rejects invalid recipientId', async () => {
    await expect(getRecipientInsights.run({ recipientId: 0 })).rejects.toThrow(/recipientId/);
  });
});

describe('getWatchlist', () => {
  it('reshapes raw rows into the tool envelope', async () => {
    watchlistRepository.getAllWithCount.mockResolvedValueOnce({
      rows: [
        { id: 1, name: 'Apple', symbol: 'AAPL', asset_class: 'stock', current_price: '174.99', currency: 'USD', notes: null },
      ],
      total: 1,
    });
    const r = await getWatchlist.run({});
    expect(r.data).toEqual([
      { id: 1, name: 'Apple', symbol: 'AAPL', assetClass: 'stock', currentPrice: 174.99, currency: 'USD', notes: null },
    ]);
    expect(r.meta).toMatchObject({ total: 1, assetClass: 'all' });
  });

  it('passes assetClass through to repo and reflects it in meta', async () => {
    watchlistRepository.getAllWithCount.mockResolvedValueOnce({ rows: [], total: 0 });
    await getWatchlist.run({ assetClass: 'crypto' });
    expect(watchlistRepository.getAllWithCount).toHaveBeenCalledWith(expect.objectContaining({ assetClass: 'crypto' }));
  });

  it('handles null current_price', async () => {
    watchlistRepository.getAllWithCount.mockResolvedValueOnce({
      rows: [{ id: 1, name: 'X', symbol: null, asset_class: 'bond', current_price: null, currency: null, notes: null }],
      total: 1,
    });
    const r = await getWatchlist.run({});
    expect(r.data[0].currentPrice).toBeNull();
    expect(r.data[0].currency).toBe('EUR'); // fallback
    expect(r.data[0].symbol).toBeNull();
  });

  it('rejects unknown asset class', async () => {
    await expect(getWatchlist.run({ assetClass: 'magic-beans' })).rejects.toThrow(/assetClass/);
  });
});

describe('getCategories', () => {
  it('reshapes rows and exposes id + general/detail/name', async () => {
    categoryRepository.getAll.mockResolvedValueOnce([
      { id: 1, general: 'Food', detail: 'Groceries' },
      { id: 2, general: 'Food', detail: null },
      { id: 3, general: null, detail: null },
    ]);
    const r = await getCategories.run({});
    expect(r.data).toEqual([
      { id: 1, general: 'Food', detail: 'Groceries', name: 'Groceries' },
      { id: 2, general: 'Food', detail: null, name: 'Food' },
      { id: 3, general: null, detail: null, name: 'Category 3' },
    ]);
  });

  it('passes search trimmed to the repository', async () => {
    categoryRepository.getAll.mockResolvedValueOnce([]);
    await getCategories.run({ search: '  Travel  ' });
    expect(categoryRepository.getAll).toHaveBeenCalledWith(expect.objectContaining({ search: 'Travel' }));
  });

  it('omits search when empty', async () => {
    categoryRepository.getAll.mockResolvedValueOnce([]);
    await getCategories.run({});
    const args = categoryRepository.getAll.mock.calls[0][0];
    expect(args.search).toBeUndefined();
  });
});

describe('getRecurringDetected', () => {
  function pattern(overrides = {}) {
    return {
      recipientName: 'Netflix',
      detectedPattern: 'monthly',
      intervalDays: 30,
      consistency: 0.95,
      occurrences: 5,
      averageAmount: -12.99,
      latestAmount: -12.99,
      currency: 'EUR',
      categoryName: 'Subscriptions',
      predictedNext: '2025-06-01',
      lastSeen: '2025-05-01',
      confidence: 'high',
      isAlreadyPlanned: false,
      ...overrides,
    };
  }

  it('reshapes patterns and applies default minOccurrences=3', async () => {
    detectRecurringPatterns.mockResolvedValueOnce({
      patterns: [pattern({ occurrences: 5 }), pattern({ recipientName: 'Spotify', occurrences: 2 })],
    });
    const r = await getRecurringDetected.run({});
    expect(r.data).toHaveLength(1);
    expect(r.data[0].recipient).toBe('Netflix');
    expect(r.meta.minOccurrences).toBe(3);
  });

  it('respects custom minOccurrences threshold', async () => {
    detectRecurringPatterns.mockResolvedValueOnce({
      patterns: [pattern({ occurrences: 2 }), pattern({ occurrences: 5 })],
    });
    const r = await getRecurringDetected.run({ minOccurrences: 2 });
    expect(r.data).toHaveLength(2);
  });

  it('rejects out-of-range minOccurrences', async () => {
    await expect(getRecurringDetected.run({ minOccurrences: 1 })).rejects.toThrow(/minOccurrences/);
    await expect(getRecurringDetected.run({ minOccurrences: 999 })).rejects.toThrow(/minOccurrences/);
  });
});
